/**
 * engine.js — the /e/authorize state machine.
 *
 * In SPEC mode this simulates the server: it negotiates capabilities against a connection
 * preset, enforces the `next` allow-list, rotates the session, and runs the decoy and
 * attempt-cap logic. In LIVE mode the same object tracks state alongside the real tenant so
 * the UI can render both identically.
 *
 * The negotiation rules are transcribed from the Protocol Negotiation doc. Every decision
 * carries a `why` string, and withheld actions are returned too — seeing why something was
 * NOT offered is usually more instructive than seeing what was.
 *
 * Where two specs disagree the conflict is marked CONFLICT rather than silently resolved.
 */

import { byId, maskIdentifier } from '../data/spec.js';

/** Spec mode needs a deterministic correct code. Surfaced in the UI — it is a simulation. */
export const SPEC_OTP = '123456';
export const MAX_OTP_ATTEMPTS = 5;

/** Users that "exist" in spec mode. Anything else resolves to a decoy (when intent is login). */
const SPEC_KNOWN_USERS = [
  {
    user_id: 'auth0|6a7a180fff96f3e77dfe67a9',
    email: 'hazel.nutt@okta.com',
    username: 'hazelnutt',
    phone_number: '+15551234567',
    hasPassword: true,
    enrolledFactors: ['totp', 'push', 'phone', 'recovery-code'],
  },
  {
    // Exists, authenticates fine, but has nothing enrolled — the no_eligible_factors case.
    user_id: 'auth0|11b2c3d4e5f60718293a4b5c',
    email: 'no-mfa@okta.com',
    username: 'nomfa',
    phone_number: null,
    hasPassword: true,
    enrolledFactors: [],
  },
];

export function freshState({ connection, declaredCaps, mfaPolicy = 'Never', nativeSdks = [] }) {
  return {
    mode: 'spec',
    phase: 'uninitialised',
    connection,
    declaredCaps: [...declaredCaps],
    mfaPolicy, // Always | Never | PasswordlessEnrollment  (static policies only, per D3 #8)
    nativeSdks, // e.g. ['google-oauth2'] — flips federated → native social
    userIdentified: false,
    user: null,
    intent: 'login',
    completedFactors: [],
    pendingChallenge: null,
    amrs: [],
    attempts: 0,
    rotations: 0,
    authSession: null,
    next: [],
    authorizationCode: null,
    terminated: null,
    history: [],
  };
}

/* ───────────────────────────── negotiation ───────────────────────────── */

const isSocial = (c) => !!c && !['auth0', 'samlp', 'ad', 'email', 'sms'].includes(c.strategy);
const isEnterprise = (c) => !!c && ['samlp', 'ad'].includes(c.strategy);

/**
 * Decide which actions are available given connection config + session state, then intersect
 * with what the client declared.
 *
 * Returns { offered, withheld } where each entry is { id, why, descriptor? }.
 */
export function negotiate(state) {
  const conn = state.connection;
  const declared = new Set(state.declaredCaps);
  const candidates = [];

  const consider = (id, eligible, why, descriptor = {}) =>
    candidates.push({ id, eligible, why, descriptor });

  if (!conn) {
    return { offered: [], withheld: [{ id: '*', why: 'No connection resolved. `connection` is required on every call — defaulting is deferred.' }] };
  }

  const ids = conn.identifiers || [];
  const methods = conn.authMethods || [];
  const identified = state.userIdentified;
  const done = state.completedFactors;

  /* -- identifiers ----------------------------------------------------- */
  consider(
    'action:identify:email:v1',
    !identified && (conn.strategy === 'email' || (conn.strategy === 'auth0' && ids.includes('email'))),
    !identified
      ? conn.strategy === 'email' || ids.includes('email')
        ? 'Connection accepts an email identifier and no user is identified yet.'
        : 'Connection does not accept an email identifier.'
      : 'A user is already identified — identify actions are no longer offered.'
  );

  consider(
    'action:identify:phone:v1',
    !identified && (conn.strategy === 'sms' || (conn.strategy === 'auth0' && ids.includes('phone'))),
    !identified
      ? ids.includes('phone') || conn.strategy === 'sms'
        ? 'Connection accepts a phone identifier. NOTE: negotiates but has no handler — invoking it returns 501.'
        : 'Connection does not accept a phone identifier.'
      : 'A user is already identified.'
  );

  consider(
    'action:identify:username:v1',
    !identified && conn.strategy === 'auth0' && ids.includes('username'),
    !identified
      ? ids.includes('username')
        ? 'Connection accepts a username identifier.'
        : 'Connection does not accept a username identifier.'
      : 'A user is already identified.'
  );

  /* -- primary factors -------------------------------------------------
     Availability is scoped by the identifier ALREADY used, not just by the connection
     (Password RFD #8). If password is enabled every identifier can reach verify:password;
     an OTP challenge is only available for the identifier the user actually identified with. */
  const idType = state.user?.identifierType;

  consider(
    'action:verify:password:v1',
    identified && conn.strategy === 'auth0' && methods.includes('password') && !done.includes('password'),
    !identified
      ? 'No user identified yet.'
      : !methods.includes('password')
      ? 'Connection does not enable the password authentication method.'
      : done.includes('password')
      ? 'Password already completed in this session.'
      : 'Password is enabled on the connection. Advertised for real users AND decoys alike — ' +
        'gating it on whether the user actually has a password would be an enumeration oracle. ' +
        '(CONFLICT: the Protocol Negotiation doc gates this on user.hasPassword; the Password RFD ' +
        'explicitly overrides that. Following the RFD.)'
  );

  const emailOtpEligible =
    conn.strategy === 'email' || (conn.strategy === 'auth0' && methods.includes('email_otp'));
  consider(
    'action:challenge:email:v1',
    identified && emailOtpEligible && idType === 'email' && !state.pendingChallenge && !done.includes('email'),
    !identified
      ? 'No user identified yet.'
      : !emailOtpEligible
      ? 'Connection does not enable email OTP.'
      : done.includes('email')
      ? 'Email OTP was already completed in this session — a factor is not offered twice ' +
        '(session.userIdentified && !completedFactors.includes(factor)).'
      : idType !== 'email'
      ? `User identified by ${idType}, so an email OTP challenge does not apply to this session. ` +
        'There is no username_otp — which is exactly why username only became a usable identifier ' +
        'once password existed.'
      : state.pendingChallenge
      ? 'A challenge is already pending.'
      : 'Email OTP is enabled and the user identified by email.'
  );

  const phoneOtpEligible =
    conn.strategy === 'sms' || (conn.strategy === 'auth0' && methods.includes('phone_otp'));
  consider(
    'action:challenge:phone:v1',
    identified && phoneOtpEligible && idType === 'phone' && !state.pendingChallenge && !done.includes('phone'),
    !identified
      ? 'No user identified yet.'
      : !phoneOtpEligible
      ? 'Connection does not enable phone OTP.'
      : done.includes('phone')
      ? 'Phone OTP was already completed in this session — a factor is not offered twice.'
      : idType !== 'phone'
      ? `User identified by ${idType} — a phone OTP challenge does not apply.`
      : 'Phone OTP is enabled and the user identified by phone.',
    { index: 0, delivery_method: ['text', 'voice'] }
  );

  /* -- pending challenge → verify -------------------------------------- */
  const pc = state.pendingChallenge;
  consider(
    'action:verify:otp:v1',
    !!pc && pc.type === 'otp',
    pc?.type === 'otp'
      ? `A code was issued over ${pc.channel}. This is the only action the server will accept next.`
      : 'No OTP challenge is pending.',
    pc?.type === 'otp' ? { channel: pc.channel, identifier: pc.masked } : {}
  );

  consider(
    'action:verify:oob:v1',
    !!pc && pc.type === 'oob',
    pc?.type === 'oob'
      ? 'A push transaction is open. Poll this action; the interval rides on the descriptor.'
      : 'No out-of-band transaction is open.',
    pc?.type === 'oob' ? { poll_in_ms: 2000 } : {}
  );

  consider(
    'action:verify:recovery-code:v1',
    !!pc && pc.type === 'recovery-code',
    pc?.type === 'recovery-code' ? 'Recovery-code challenge recorded.' : 'No recovery-code challenge pending.'
  );

  /* -- MFA second factors ---------------------------------------------- */
  const mfaDue = state.phase === 'mfa-required';
  const enrolled = state.user?.enrolledFactors || [];
  for (const [id, factor, descriptor] of [
    ['action:challenge:totp:v1', 'totp', {}],
    ['action:challenge:push:v1', 'push', { index: 0, name: "Diego's iPhone" }],
    ['action:challenge:recovery-code:v1', 'recovery-code', {}],
  ]) {
    consider(
      id,
      mfaDue && enrolled.includes(factor) && !state.pendingChallenge,
      !mfaDue
        ? 'A second factor is not currently required.'
        : !enrolled.includes(factor)
        ? `User has no ${factor} authenticator enrolled.`
        : state.pendingChallenge
        ? 'A challenge is already pending.'
        : `${factor} is enrolled and tenant-enabled. One descriptor is emitted per eligible authenticator.`,
      descriptor
    );
  }
  // Email/phone double as MFA challenges — same action ids, reused unchanged (D3).
  if (mfaDue && !state.pendingChallenge) {
    for (const [id, factor, descriptor] of [
      ['action:challenge:email:v1', 'email', { index: 0, identifier: maskIdentifier(state.user?.email || '') }],
      ['action:challenge:phone:v1', 'phone', { index: 0, identifier: '+1******67', delivery_method: ['text', 'voice'] }],
    ]) {
      if (enrolled.includes(factor)) {
        const existing = candidates.find((c) => c.id === id);
        if (existing) {
          existing.eligible = true;
          existing.why = `Reused as an MFA challenge — the same action id the primary path uses. The client cannot tell a primary factor from a secondary one; the server decides what the action means from sealed state.`;
          existing.descriptor = descriptor;
        }
      }
    }
  }

  /* -- federated / native social --------------------------------------- */
  const nativeFor = (c) => state.nativeSdks.includes(c.strategy);
  consider(
    'authn:federated:v1',
    (isEnterprise(conn) || (isSocial(conn) && !nativeFor(conn))) && !identified,
    isEnterprise(conn)
      ? 'Enterprise connection — always a browser handoff, there is no native path.'
      : isSocial(conn)
      ? nativeFor(conn)
        ? `Client declares a native SDK for ${conn.strategy}, so a native social action is offered instead.`
        : 'Social connection with no native SDK declared — hand off to the browser.'
      : 'Not a federated connection.',
    isEnterprise(conn) || isSocial(conn) ? { specialisedAs: `authn:federated:${conn.strategy}:v1` } : {}
  );

  consider(
    'authn:oauth2:v1',
    (isEnterprise(conn) || isSocial(conn)) && !identified,
    isEnterprise(conn) || isSocial(conn)
      ? 'Selecting this returns redirect_to_web + a request_uri; the IdP round-trip happens in the browser.'
      : 'Not a federated connection.',
    { connection: conn.strategy }
  );

  for (const [id, strategy] of [
    ['authn:ns:google:v1', 'google-oauth2'],
    ['authn:ns:apple:v1', 'apple'],
    ['authn:ns:facebook:v1', 'facebook'],
  ]) {
    consider(
      id,
      conn.strategy === strategy && nativeFor(conn) && !identified,
      conn.strategy !== strategy
        ? `Connection is not ${strategy}.`
        : nativeFor(conn)
        ? 'Native SDK declared for this strategy — no browser opens.'
        : `No native SDK declared for ${strategy}, so the federated redirect is offered instead.`
    );
  }

  /* -- passkey ---------------------------------------------------------- */
  consider(
    'authn:passkey:v1',
    conn.strategy === 'auth0' && methods.includes('passkey') && !identified,
    methods.includes('passkey')
      ? 'Returned EAGERLY alongside the identify actions, with authn_params_public_key — that is ' +
        'what makes conditional mediation (passkey autofill) possible.'
      : 'Connection does not enable passkeys.',
    { authn_params_public_key: '{ challenge, rpId, allowCredentials }' }
  );

  /* -- signup ----------------------------------------------------------- */
  consider(
    'action:signup:v1',
    !identified && state.intent === 'login' && conn.strategy === 'auth0',
    conn.strategy === 'auth0'
      ? 'Switches session intent to signup. Sign-in and signup share one response shape by design.'
      : 'Signup applies to database connections.'
  );

  /* -- split by declared capability ------------------------------------- */
  const offered = [];
  const withheld = [];
  for (const c of candidates) {
    if (!declared.has(c.id)) {
      withheld.push({
        id: c.id,
        why: c.eligible
          ? 'The server would offer this, but the client did not declare it. Capability negotiation is an intersection — declaring less narrows what you can be asked to do.'
          : c.why,
        serverWouldOffer: c.eligible,
      });
      continue;
    }
    (c.eligible ? offered : withheld).push({
      id: c.id,
      why: c.why,
      descriptor: c.descriptor,
      serverWouldOffer: c.eligible,
    });
  }
  return { offered, withheld };
}

/** Build the wire-shape `next` array from negotiation output. */
function nextFromOffered(offered) {
  return offered.map(({ id, descriptor }) => {
    const entry = { action: id };
    for (const [k, v] of Object.entries(descriptor || {})) {
      if (k === 'specialisedAs') continue;
      entry[k] = v;
    }
    if (descriptor?.specialisedAs) entry.action = descriptor.specialisedAs;
    return entry;
  });
}

/* ───────────────────────────── responses ───────────────────────────── */

function rotate(state) {
  state.rotations += 1;
  state.authSession = `spec-session-${state.rotations}`;
  return state.authSession;
}

const continuation = (state, next, error_description) => {
  const body = { error: 'insufficient_authorization' };
  if (error_description) body.error_description = error_description;
  body.auth_session = rotate(state);
  body.next = next;
  return { status: 403, body };
};

const terminal = (state, error_description) => {
  state.terminated = error_description;
  state.phase = 'terminated';
  state.next = [];
  return { status: 403, body: { error: 'access_denied', error_description } };
};

const badRequest = (error_description) => ({
  status: 400,
  body: { error: 'invalid_request', error_description },
});

const complete = (state) => {
  state.phase = 'complete';
  state.authorizationCode = 'AUTH_CODE_' + Math.random().toString(36).slice(2, 12);
  state.next = [];
  return { status: 200, body: { authorization_code: state.authorizationCode } };
};

/* ───────────────────────────── transitions ───────────────────────────── */

/**
 * Can the client actually AUTHENTICATE against this connection, ignoring session state?
 *
 * An identifier alone is not enough. The Password RFD is explicit: a connection with password
 * enabled and no email_otp "negotiates to an empty capability intersection, so /e/authorize
 * rejects the initiate call with 400 invalid_request" — even though the email identifier is
 * perfectly valid. So the gate is on methods, not identifiers.
 */
function hasUsableAuthMethod(state) {
  const conn = state.connection;
  const declared = new Set(state.declaredCaps);
  const methods = conn.authMethods || [];
  const any = (...ids) => ids.some((id) => declared.has(id));

  if (declared.has('action:signup:v1')) return true; // signup brings its own enrollment path

  if (conn.strategy === 'auth0') {
    if (methods.includes('email_otp') && any('action:challenge:email:v1', 'action:verify:otp:v1')) return true;
    if (methods.includes('phone_otp') && any('action:challenge:phone:v1', 'action:verify:otp:v1')) return true;
    if (methods.includes('password') && any('action:verify:password:v1')) return true;
    if (methods.includes('passkey') && any('authn:passkey:v1', 'authn:passkey:register:v1')) return true;
    return false;
  }
  if (conn.strategy === 'email') return any('action:challenge:email:v1', 'action:verify:otp:v1');
  if (conn.strategy === 'sms') return any('action:challenge:phone:v1', 'action:verify:otp:v1');

  // Federated: any handoff or native-social capability will do.
  return any(
    'authn:federated:v1', 'authn:oauth2:v1',
    'authn:ns:google:v1', 'authn:ns:apple:v1', 'authn:ns:facebook:v1'
  );
}

/** The initiate call. */
export function initiate(state) {
  if (!state.connection) return badRequest("data must have required property 'connection'");

  const { offered, withheld } = negotiate(state);

  if (!hasUsableAuthMethod(state)) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Client does not support the capabilities required by the server',
      },
      note:
        'The connection offers no authentication method the client declared. An identifier on its ' +
        'own is not enough — you can say who you are but never prove it, so the server refuses at ' +
        'initiate rather than leading you into a dead end. This is exactly the gap the Password RFD ' +
        'exists to close: password-only connections (most tenants) hit this today.',
      negotiation: { offered, withheld },
    };
  }

  if (offered.length === 0) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'Client does not support the capabilities required by the server',
      },
      negotiation: { offered, withheld },
    };
  }

  state.phase = 'initiated';
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  return res;
}

/**
 * A continuation call. Enforces the `next` allow-list first — that is the whole contract.
 */
export function submit(state, action, payload = {}) {
  const allowed = state.next.map((n) => n.action);

  if (state.phase === 'complete' || state.phase === 'terminated') {
    return badRequest('The flow is over. Restart from initiate.');
  }

  if (!allowed.includes(action)) {
    // Refused correctly — but the live tenant returns 500 here, not a 4xx. Reproduced
    // faithfully so the playground shows the real behaviour, flagged as a known gap.
    return {
      status: 500,
      body: { error: 'server_error', error_description: 'An unexpected error occurred.' },
      note:
        `"${action}" is not in the current next allow-list [${allowed.join(', ') || 'empty'}]. ` +
        'The server is right to refuse it — but a 500 is a bug, not the intended invalid_request. ' +
        'Verified live.',
      gap: 'Out-of-order action returns 500, not invalid_request',
    };
  }

  switch (action) {
    case 'action:signup:v1': {
      state.intent = 'signup';
      const { offered, withheld } = negotiate(state);
      const next = nextFromOffered(offered.filter((o) => o.id.startsWith('action:identify:')));
      state.next = next;
      const res = continuation(state, next);
      res.negotiation = { offered, withheld };
      return res;
    }

    case 'action:identify:email:v1':
    case 'action:identify:username:v1':
    case 'action:identify:phone:v1':
      return doIdentify(state, action, payload);

    case 'action:challenge:email:v1':
    case 'action:challenge:phone:v1':
      return doOtpChallenge(state, action);

    case 'action:challenge:totp:v1':
    case 'action:challenge:recovery-code:v1':
      return doNoopChallenge(state, action);

    case 'action:challenge:push:v1':
      return doPushChallenge(state);

    case 'action:verify:otp:v1':
      return doVerifyOtp(state, payload);

    case 'action:verify:password:v1':
      return doVerifyPassword(state, payload);

    case 'action:verify:recovery-code:v1':
      return doVerifyRecoveryCode(state, payload);

    case 'action:verify:oob:v1':
      return doPollOob(state, payload);

    case 'action:signup:confirm:v1':
      return complete(state);

    default:
      return {
        status: 501,
        body: { error: 'not_implemented', error_description: `No handler registered for ${action}.` },
        note:
          'The capability negotiates and is advertised in `next`, but no handler exists — the ' +
          'gap the Password RFD calls out for identify:phone.',
      };
  }
}

function doIdentify(state, action, payload) {
  const field =
    action === 'action:identify:email:v1'
      ? 'email'
      : action === 'action:identify:username:v1'
      ? 'username'
      : 'phone_number';
  const value = String(payload[field] || '').trim();

  if (!value) return badRequest(`Missing "${field}".`);
  if (field === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return badRequest('Invalid email format.');
  }

  if (action === 'action:identify:phone:v1') {
    return {
      status: 501,
      body: { error: 'not_implemented', error_description: 'No handler registered for action:identify:phone:v1.' },
      note:
        'Negotiated but unimplemented. On a phone-only connection this makes embedded login ' +
        'unreachable — flagged in the Password RFD non-goals.',
      gap: 'identify:phone negotiates but has no handler',
    };
  }

  const idType = field === 'phone_number' ? 'phone' : field;
  const known = SPEC_KNOWN_USERS.find(
    (u) => String(u[field] || '').toLowerCase() === value.toLowerCase()
  );

  // `intent` and `decoy` are orthogonal (D2 #5). During SIGNUP an unknown identifier is the
  // expected case, not a decoy — a decoy only exists to mask non-existence during LOGIN.
  const signingUp = state.intent === 'signup';

  state.userIdentified = true;
  state.user = known
    ? { ...known, identifier: value, identifierType: idType, decoy: false }
    : {
        // Decoy: no user_id at all — enforced both in buildUser and by the payload schema
        // (`if decoy: true then not required: [user_id]`).
        user_id: signingUp ? 'auth0|pending-signup' : undefined,
        email: idType === 'email' ? value : null,
        username: idType === 'username' ? value : null,
        phone_number: null,
        hasPassword: false,
        enrolledFactors: [],
        identifier: value,
        identifierType: idType,
        decoy: !signingUp,
      };

  const { offered, withheld } = negotiate(state);
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  res.note = state.user.decoy
    ? 'This identifier resolved to NO user — a decoy was sealed into the session (user_id absent). ' +
      'The response is deliberately identical to the known-user case: same status, same next, same ' +
      'shape. Compare it against a known identifier and you should find no difference.'
    : 'User resolved. The response shape is identical to the decoy case by design.';
  return res;
}

function doOtpChallenge(state, action) {
  const channel = action === 'action:challenge:email:v1' ? 'email' : 'phone';
  const target = channel === 'email' ? state.user?.email || state.user?.identifier : state.user?.phone_number || state.user?.identifier;

  state.pendingChallenge = {
    type: 'otp',
    channel,
    masked: maskIdentifier(target || ''),
    // Real user: the users-service ticket id, held server-side only, never returned.
    ticketId: state.user?.decoy ? undefined : 'otp_ticket_' + Math.random().toString(36).slice(2, 10),
  };
  state.attempts = 0;

  const { offered, withheld } = negotiate(state);
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  res.note = state.user?.decoy
    ? 'DECOY: no code was sent and no ticket exists. The response time is padded to match a real ' +
      'send so latency does not leak existence — and the masked identifier is a mask of the address ' +
      'that was submitted, so even that looks normal.'
    : `Code sent over ${channel}. In spec mode the correct code is ${SPEC_OTP}. The users-service ` +
      'ticket id is sealed in action_state and never returned to the client.';
  return res;
}

function doNoopChallenge(state, action) {
  const type = action === 'action:challenge:totp:v1' ? 'otp' : 'recovery-code';
  state.pendingChallenge = { type, channel: type === 'otp' ? 'totp' : 'recovery-code', masked: '' };
  state.attempts = 0;

  const { offered, withheld } = negotiate(state);
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  res.note =
    'Sends nothing — the credential is already on the client. The challenge exists only to record ' +
    'the chosen factor and commit to what the server will accept next. The RAPID argues this ' +
    'round-trip is structural fiction and should be dropped (its recommended Option 2).';
  return res;
}

function doPushChallenge(state) {
  state.pendingChallenge = {
    type: 'oob',
    channel: 'push',
    masked: '',
    transactionId: 'oob_tx_' + Math.random().toString(36).slice(2, 10),
    challengedAt: Date.now(),
    polls: 0,
  };
  const { offered, withheld } = negotiate(state);
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  res.note =
    'Out-of-band transaction opened. Push is the only poll-based factor — there is no code to type. ' +
    'poll_in_ms travels on the verify:oob descriptor, not the response root.';
  return res;
}

function doVerifyOtp(state, payload) {
  const pc = state.pendingChallenge;
  const submitted = String(payload.otp || '');

  // Decoy: rejected with NO users-service call at all. The server already knows from sealed
  // state that no code exists. Response must be byte-identical to a wrong code.
  const wrong = state.user?.decoy || submitted !== SPEC_OTP;

  if (wrong) {
    state.attempts += 1;
    if (state.attempts >= MAX_OTP_ATTEMPTS) {
      const res = terminal(state, 'too_many_wrong_otp_attempts');
      res.note =
        `Cap of ${MAX_OTP_ATTEMPTS} reached. For a real user auth0-users' own limiter trips; for a ` +
        'decoy an orchestrator counter mimics it at exactly the same number — so lockout timing ' +
        'cannot leak existence either. Terminal: no next, no auth_session.';
      return res;
    }
    const { offered } = negotiate(state);
    const next = nextFromOffered(offered);
    state.next = next;
    const res = continuation(state, next, 'invalid_identifier_or_code');
    res.note = state.user?.decoy
      ? `DECOY rejection — no backend call was made. Byte-identical to a wrong code. Attempt ` +
        `${state.attempts}/${MAX_OTP_ATTEMPTS}. "invalid_identifier_or_code" is deliberately vague: ` +
        'it collapses "wrong code" and "no such user" into one string, which is what makes the two ' +
        'indistinguishable.'
      : `Wrong code. Recoverable — retry against the rotated session. Attempt ${state.attempts}/${MAX_OTP_ATTEMPTS}.`;
    return res;
  }

  // Correct.
  const factor = pc.channel === 'totp' ? 'totp' : pc.channel;
  state.completedFactors.push(factor);
  state.pendingChallenge = null;
  state.attempts = 0;
  state.amrs.push({ name: state.phase === 'mfa-required' ? 'mfa' : 'email', timestamp: Date.now(), type: factor });

  return afterFactor(state, `Code accepted over ${pc.channel}.`);
}

function doVerifyPassword(state, payload) {
  if (!payload.password) return badRequest('Missing "password".');

  // Every negative outcome collapses to one response — wrong password, decoy, blocked user,
  // blocked IP, breached password, custom-DB rejection.
  if (state.user?.decoy || payload.password !== 'Abcd@1234') {
    const { offered } = negotiate(state);
    const next = nextFromOffered(offered);
    state.next = next;
    const res = continuation(state, next, 'invalid_identifier_or_password');
    res.note =
      'One uniform failure. Wrong password, unknown user, blocked user, blocked IP, breached ' +
      'password, and a custom-DB script rejection all produce exactly this — a deliberate loss of ' +
      'fidelity, because "user is blocked" is a true statement about an account that exists. ' +
      '`next` re-advertises every method still available, so the client can switch to OTP without ' +
      'restarting. (Spec mode accepts Abcd@1234.)';
    return res;
  }

  state.completedFactors.push('password');
  state.amrs.push({ name: 'pwd', timestamp: Date.now() });
  return afterFactor(state, 'Password verified through the same /wsfed/direct call and AnomalyDetection chain Universal Login uses.');
}

function doVerifyRecoveryCode(state, payload) {
  if (!payload.recovery_code) return badRequest('Missing "recovery_code".');
  if (String(payload.recovery_code).length < 8) {
    const { offered } = negotiate(state);
    state.next = nextFromOffered(offered);
    return continuation(state, state.next, 'invalid_code');
  }
  state.completedFactors.push('recovery-code');
  state.pendingChallenge = null;
  state.amrs.push({ name: 'mfa', timestamp: Date.now(), type: 'recovery-code' });
  return afterFactor(state, 'Recovery code accepted.');
}

export const PUSH_POLL_IN_MS = 2000;

function doPollOob(state, payload) {
  const pc = state.pendingChallenge;

  // Pacing is enforced against the session's iat, and iat is refreshed on every rotation —
  // so the interval runs from the LAST response, not from the original challenge. The
  // transaction is not inspected at all when the client polls early.
  const sinceLast = Date.now() - (pc.lastPollAt ?? pc.challengedAt);
  if (sinceLast < PUSH_POLL_IN_MS && pc.polls > 0 && !payload.simulate) {
    const res = continuation(state, state.next, 'slow_down');
    res.note =
      `Polled ${sinceLast}ms after the previous response, inside the ${PUSH_POLL_IN_MS}ms window. ` +
      'The server returned immediately WITHOUT calling mfaApi.verify.oob — the interval is enforced ' +
      'server-side, never trusted to the client.';
    return res;
  }

  pc.polls += 1;
  pc.lastPollAt = Date.now();

  // Spec mode: approve on the third poll so the pending state is visible.
  if (payload.simulate === 'rejected') {
    const res = terminal(state, 'authorization_rejected');
    res.note = 'The user denied the push. A decision, not something to retry — terminal.';
    return res;
  }
  if (payload.simulate === 'expired') {
    const res = terminal(state, 'challenge_expired');
    res.note = 'The out-of-band transaction expired or was not found.';
    return res;
  }
  if (pc.polls < 3) {
    const res = continuation(state, state.next, 'authorization_pending');
    res.note = `TX_STATUS.PENDING — poll ${pc.polls}. Same action offered again, with its poll_in_ms.`;
    return res;
  }

  state.completedFactors.push('push');
  state.pendingChallenge = null;
  state.amrs.push({ name: 'mfa', timestamp: Date.now(), type: 'push-notification' });
  return afterFactor(state, 'TX_STATUS.ACCEPTED — the user approved the push.');
}

/**
 * After any factor completes: signup fork, then MFA policy, then finish.
 */
function afterFactor(state, note) {
  if (state.intent === 'signup') {
    const canEnroll =
      state.declaredCaps.includes('action:enroll:password:v1') &&
      (state.connection.authMethods || []).includes('password') &&
      !state.completedFactors.includes('password');
    const next = canEnroll
      ? [{ action: 'action:enroll:password:v1' }, { action: 'action:signup:confirm:v1' }]
      : [{ action: 'action:signup:confirm:v1' }];
    state.next = next;
    const res = continuation(state, next);
    res.note = note + ' Identifier verified — signup can now be confirmed.';
    return res;
  }

  const mfaRequired =
    state.mfaPolicy === 'Always' && !state.completedFactors.some((f) => ['totp', 'push', 'recovery-code'].includes(f));

  if (mfaRequired) {
    const enrolled = state.user?.enrolledFactors || [];
    state.phase = 'mfa-required';
    const { offered, withheld } = negotiate(state);
    const next = nextFromOffered(offered.filter((o) => o.id.startsWith('action:challenge:')));

    if (next.length === 0) {
      const res = terminal(state, 'no_eligible_factors');
      res.note =
        'Policy requires a second factor but the user has no eligible enrolled factor, and this ' +
        'delivery adds no in-flow enrollment. Terminal by design — the client falls back to a ' +
        'redirect-based flow.';
      return res;
    }

    state.next = next;
    const res = continuation(state, next);
    res.negotiation = { offered, withheld };
    res.note =
      note +
      ' MFA policy requires a second factor, so the pipeline pauses AGAIN — the same pause/resume ' +
      'contract as the primary factor, one step further down. One descriptor per eligible ' +
      `authenticator (enrolled: ${enrolled.join(', ') || 'none'}).`;
    return res;
  }

  state.phase = 'authenticated';
  const res = complete(state);
  res.note =
    note +
    ' All required factors satisfied — the orchestrator resumed the paused TDE pipeline, which ' +
    'reached consent and grant/code.js and issued a real authorization code. Exchange it at ' +
    'POST /oauth/token with the standard authorization_code grant.';
  return res;
}

/** The conceptual auth_session payload, for the inspector. */
export function sessionPayload(state) {
  if (!state.authSession) return null;
  return {
    auth_request_params: {
      client_id: '<client_id>',
      connection: state.connection?.id,
      capabilities: state.declaredCaps,
    },
    embedded_resume_state: '<TDE-owned; written once at pause, read once at resume>',
    embedded_auth_state: {
      next: state.next.map((n) => n.action),
      user: state.user
        ? state.user.decoy
          ? { user_id: undefined, email: state.user.email, decoy: true }
          : { user_id: state.user.user_id, email: state.user.email, decoy: false }
        : null,
      intent: state.intent,
      action_state: state.pendingChallenge
        ? {
            otp_ticket_id: state.pendingChallenge.ticketId || '<absent on decoy>',
            transaction_id: state.pendingChallenge.transactionId,
            attempts: state.user?.decoy ? state.attempts : undefined,
          }
        : {},
    },
    amrs: state.amrs,
    jti: `spec-jti-${state.rotations}`,
    iat: '<issued at>',
    exp: '<+15 min>',
  };
}
