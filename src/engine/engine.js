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

import {
  byId,
  maskIdentifier,
  isFederatedAction,
  connectionOfFederatedAction,
  federatedConnections,
  ENTERPRISE_STRATEGIES,
  LOCAL_STRATEGIES,
  NATIVE_SOCIAL_ACTIONS,
  ARTIFACT_TYPE_BY_PROVIDER,
} from '../data/spec.js';

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

export function freshState({
  connection,
  declaredCaps,
  mfaPolicy = 'Never',
  nativeSdks = [],
  botDetection = 'off',
  postLogin = 'none',
}) {
  return {
    mode: 'spec',
    phase: 'uninitialised',
    connection,
    declaredCaps: [...declaredCaps],
    mfaPolicy, // Always | Never | PasswordlessEnrollment  (static policies only, per D3 #8)
    nativeSdks, // e.g. ['google-oauth2'] — flips federated → native social
    // off | adaptive | actions | block — the three response modes BOT defines, plus off.
    botDetection,
    // none | form | web — a post-login Action that needs a web leg before the code is issued.
    postLogin,
    userIdentified: false,
    user: null,
    intent: 'login',
    completedFactors: [],
    pendingChallenge: null,
    // The open escape-to-web leg, if any. One at a time — the pipeline is paused while it runs.
    webLeg: null,
    // BOT: CAPTCHA clearance is single-use across credential attempts.
    captchaCleared: false,
    boundIp: null,
    postLoginDone: false,
    amrs: [],
    attempts: 0,
    rotations: 0,
    authSession: null,
    // Sessions already burned by an accepted request. Presenting one again is invalid_session.
    consumedSessions: [],
    // PKCE challenge from the initiate call. Without it no request_uri may be returned.
    codeChallenge: null,
    next: [],
    authorizationCode: null,
    terminated: null,
    history: [],
  };
}

/* ───────────────────────────── negotiation ───────────────────────────── */

/* Strategy classification, from REDIR's own enumeration rather than a two-entry guess — the
   earlier list treated oidc, waad, adfs, wsfed, ldap and pingfederate as SOCIAL, which would have
   offered a native-SDK path to enterprise IdPs that have none. */
const isEnterprise = (c) => !!c && ENTERPRISE_STRATEGIES.includes(c.strategy);
const isSocial = (c) => !!c && !LOCAL_STRATEGIES.includes(c.strategy) && !isEnterprise(c);
const isFederated = (c) => isEnterprise(c) || isSocial(c);

/* ── escape-to-web plumbing (REDIR) ──────────────────────────────────────────
   Every web leg — federation, CAPTCHA, forms, Actions redirect — is coordinated by an opaque
   server-side handle in the RFC 9126 URN shape. It is a Redis lookup key, not a token: it carries
   no authentication material and is worthless off the session it was minted for. */

const RANDOM_REF = () => Math.random().toString(36).slice(2, 12);

const requestUri = (prefix) => `urn:ietf:params:oauth:request_uri:${prefix}_${RANDOM_REF()}`;

const TENANT = 'https://{{tenant}}.auth0.com';

/** TTLs are per-case in REDIR; carried here so the inspector can show them. */
const WEB_LEG_TTL_S = { captcha: 90, federation: 300, form: 600, web: 600 };

function openWebLeg(state, leg) {
  // `leg` is spread FIRST: reissuing after an abandonment passes the old record in wholesale, and
  // the whole point of a reissue is that it gets a brand new reference.
  state.webLeg = {
    ...leg,
    status: 'PENDING',
    requestUri: requestUri(leg.kind === 'federation' ? 'fed' : leg.kind),
    ttlSeconds: WEB_LEG_TTL_S[leg.kind],
    // The record is keyed to the session by a HASH of it — never the session itself.
    authSessionRef: `sha256(${state.authSession ?? 'pending'})`,
  };
  return state.webLeg;
}

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

  /* A pending OTP does NOT withdraw its own challenge action — it stays on offer so the user can
     ask for another code. Every one of the 36 signup responses that offers verify:otp re-offers
     the challenge beside it, with an identical descriptor; sign-in behaves the same way. Without
     this, a user who never received the code has no recourse but to restart the whole flow.

     Only the matching channel is re-offered: a pending email OTP does not reopen the phone
     challenge, and a pending push transaction reopens nothing. */
  const resendableOn = (channel) =>
    state.pendingChallenge?.type === 'otp' && state.pendingChallenge.channel === channel;
  const challengeable = (channel) => !state.pendingChallenge || resendableOn(channel);
  const maskedFor = (channel) =>
    maskIdentifier(
      (channel === 'email' ? state.user?.email : state.user?.phone_number) || state.user?.identifier || ''
    );

  const emailOtpEligible =
    conn.strategy === 'email' || (conn.strategy === 'auth0' && methods.includes('email_otp'));
  consider(
    'action:challenge:email:v1',
    identified && emailOtpEligible && idType === 'email' && challengeable('email') && !done.includes('email'),
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
      : resendableOn('email')
      ? 'A code is already outstanding, and the challenge stays on offer beside verify:otp so the ' +
        'user can request another one. Resending does NOT reset the wrong-code counter.'
      : state.pendingChallenge
      ? 'A different challenge is already pending.'
      : 'Email OTP is enabled and the user identified by email.',
    identified && idType === 'email' ? { index: 0, identifier: maskedFor('email') } : {}
  );

  const phoneOtpEligible =
    conn.strategy === 'sms' || (conn.strategy === 'auth0' && methods.includes('phone_otp'));
  consider(
    'action:challenge:phone:v1',
    identified && phoneOtpEligible && idType === 'phone' && challengeable('phone') && !done.includes('phone'),
    !identified
      ? 'No user identified yet.'
      : !phoneOtpEligible
      ? 'Connection does not enable phone OTP.'
      : done.includes('phone')
      ? 'Phone OTP was already completed in this session — a factor is not offered twice.'
      : idType !== 'phone'
      ? `User identified by ${idType} — a phone OTP challenge does not apply.`
      : resendableOn('phone')
      ? 'A code is already outstanding, and the challenge stays on offer so the user can request ' +
        'another — or switch delivery_method from text to voice. Resending does NOT reset the ' +
        'wrong-code counter.'
      : 'Phone OTP is enabled and the user identified by phone.',
    identified && idType === 'phone'
      ? { index: 0, identifier: maskedFor('phone'), delivery_method: ['text', 'voice'] }
      : { index: 0, delivery_method: ['text', 'voice'] }
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

  /* -- federated / native social ---------------------------------------
     REDIR: "The connection name is encoded in the action string — authn:federated:<connection-
     name>:v1. The server emits one item per eligible connection. `strategy` alone cannot
     discriminate — a client can have multiple connections with the same strategy."

     So the generic capability the client declares (authn:federated:v1) fans out into one
     candidate per eligible connection, each specialised on the connection NAME. Keying this on
     strategy — as it was — collapses two same-strategy connections into one action and makes the
     second IdP unreachable. */
  const nativeFor = (fc) => state.nativeSdks.includes(fc.strategy);
  const allFeds = isFederated(conn) ? federatedConnections(conn) : [];
  // A social connection with a native SDK declared goes native instead of opening a browser.
  const redirectFeds = allFeds.filter((fc) => isEnterprise(conn) || !nativeFor(fc));

  if (redirectFeds.length && !identified) {
    // Path A vs Path B. REDIR resolves the identifier's domain through HRD; the simulator has no
    // HRD table, so "exactly one eligible connection" stands in for "HRD resolved it" — the same
    // condition the two paths actually turn on: can the server pick without asking?
    const pathA = redirectFeds.length === 1;
    for (const fc of redirectFeds) {
      consider(
        'authn:federated:v1',
        true,
        pathA
          ? `Path A — ${fc.name} is the only eligible federated connection, so the server resolves ` +
            'it without asking and the descriptor already carries its href. One round-trip.'
          : `Path B — ${redirectFeds.length} federated connections are eligible, so no href yet. ` +
            'The client renders the choice and echoes one action back; the server mints the ' +
            'request_uri on that second call.',
        { specialisedAs: `authn:federated:${fc.name}:v1`, connectionName: fc.name, pathA }
      );
    }
  } else {
    consider(
      'authn:federated:v1',
      false,
      identified
        ? 'A user is already identified — federation is a first-factor path.'
        : !isFederated(conn)
        ? 'Not a federated connection.'
        : `Every eligible connection (${allFeds.map((f) => f.name).join(', ')}) has a native SDK ` +
          'declared, so native social is offered instead and no browser opens.'
    );
  }

  for (const [strategy, id] of Object.entries(NATIVE_SOCIAL_ACTIONS)) {
    const fc = allFeds.find((f) => f.strategy === strategy);
    consider(
      id,
      !!fc && nativeFor(fc) && !identified && isSocial(conn),
      !fc
        ? `No ${strategy} connection is configured.`
        : isEnterprise(conn)
        ? 'Enterprise connection — there is no native path, always a browser handoff.'
        : nativeFor(fc)
        ? `Native SDK declared for ${strategy} — no browser opens. The app posts back an ` +
          'idp_artifact instead of completing a redirect.'
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

  // While a challenge is outstanding the signup PRD prints the verify action FIRST and the resend
  // second — the thing you are expected to do, then the fallback. Sort is stable, so everything
  // else keeps the order it was considered in.
  if (state.pendingChallenge) {
    const rank = (id) =>
      id.startsWith('action:verify:') ? 0 : id.startsWith('action:challenge:') ? 1 : 2;
    offered.sort((a, b) => rank(a.id) - rank(b.id));
  }

  return { offered, withheld };
}

/** Descriptor keys the negotiator uses for its own bookkeeping — never wire fields. */
const INTERNAL_DESCRIPTOR_KEYS = new Set(['specialisedAs', 'connectionName', 'pathA']);

/** Build the wire-shape `next` array from negotiation output. */
function nextFromOffered(offered) {
  return offered.map(({ id, descriptor }) => {
    const entry = { action: id };
    for (const [k, v] of Object.entries(descriptor || {})) {
      if (INTERNAL_DESCRIPTOR_KEYS.has(k)) continue;
      entry[k] = v;
    }
    if (descriptor?.specialisedAs) entry.action = descriptor.specialisedAs;
    return entry;
  });
}

/**
 * Path A only: HRD resolved federation to a single connection, so the href rides on the FIRST
 * response and the coordination reference has to exist by the time that response leaves.
 *
 * Kept out of negotiate() deliberately — negotiate is pure and is also called by the session
 * inspector, which must not mint request_uris as a side effect of being looked at.
 */
function attachPathAHref(state, offered, next) {
  const pathA = offered.find((o) => o.descriptor?.pathA);
  if (!pathA) return next;
  const leg = openWebLeg(state, {
    kind: 'federation',
    browser: true,
    action: pathA.descriptor.specialisedAs,
    connectionName: pathA.descriptor.connectionName,
  });
  return next.map((entry) =>
    entry.action === pathA.descriptor.specialisedAs
      ? { ...entry, href: `${TENANT}/authorize?request_uri=${leg.requestUri}`, expires_in: leg.ttlSeconds }
      : entry
  );
}

/* ───────────────────────────── responses ───────────────────────────── */

function rotate(state) {
  // The draft: "Clients MUST NOT assume that auth_session values are static." Every response
  // carries a fresh one, and the value it replaces is burned — D2 decision #4 makes each accepted
  // request consume its jti. The live tenant does not enforce that yet; the simulator shows the
  // end state and the deviation is recorded as a known gap.
  if (state.authSession) state.consumedSessions.push(state.authSession);
  state.rotations += 1;
  state.authSession = `spec-session-${state.rotations}`;
  return state.authSession;
}

/**
 * Validate an inbound auth_session, when the client sent one.
 *
 * Returns an error response, or null if the session is acceptable. The draft defines
 * `invalid_session` for exactly this — "The provided auth_session is invalid, expired, revoked,
 * or otherwise not acceptable" — where the tenant currently answers `invalid_grant`, a code
 * RFC 6749 defines for a bad authorization grant rather than for a session.
 */
function checkSession(state, presented) {
  if (presented == null) return null; // not sent; nothing to validate
  if (presented === state.authSession) return null;

  const replayed = state.consumedSessions.includes(presented);
  return {
    status: 400,
    body: {
      error: 'invalid_session',
      error_description: 'The provided auth_session is invalid, expired, revoked, or otherwise not acceptable.',
    },
    note: replayed
      ? 'That auth_session was already consumed. Each accepted request burns the session it was ' +
        'presented with and the response carries a fresh one, so a value can be used exactly once ' +
        '(D2 decision #4). Send the auth_session from the MOST RECENT response.\n\n' +
        'The live tenant does not do this — the same auth_session can be replayed indefinitely ' +
        'there, which is what makes challenge:email an OTP-bombing vector. See the known gap.'
      : 'No session by that value was ever issued. The error is deliberately identical to the ' +
        'replay case: distinguishing "expired" from "never existed" would tell an attacker ' +
        'whether a guessed value had ever been real.\n\n' +
        'invalid_session is the draft\'s own code for this. The tenant returns invalid_grant, ' +
        'which RFC 6749 defines for a bad authorization grant — an auth_session is not one.',
    gap: replayed ? 'auth_session replay is not rejected' : undefined,
  };
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

/**
 * A malformed request: a required field missing or unusable.
 *
 * Nothing was consumed, so the session survives and the allow-list still stands — both are handed
 * back so the client can fix the body and carry on. The draft is explicit that this is how it
 * works: "The client MUST include the auth_session in follow-up requests to the authorization
 * challenge endpoint if it receives one along with the error response."
 *
 * Note the error_description here is PROSE, not one of the coded values the 403s carry. That is
 * the split RFC 6749 actually intends — human-readable text to help the developer — and the one
 * place this contract uses the field the way the RFC defines it.
 */
const badRequest = (error_description, state) => {
  const body = { error: 'invalid_request', error_description };
  const resumable = !!state?.authSession;
  if (resumable) {
    body.auth_session = state.authSession;
    body.next = state.next;
  }
  return {
    status: 400,
    body,
    note:
      'The request body did not satisfy the action\'s schema, so nothing was attempted. ' +
      (resumable
        ? 'The session is untouched and its `next` is restated — fix the body and send again; ' +
          'there is no need to restart. The draft expects exactly this: "The client MUST include ' +
          'the auth_session in follow-up requests to the authorization challenge endpoint if it ' +
          'receives one along with the error response."'
        : 'No session exists yet, so there is nothing to hand back.') +
      '\n\nNote the error_description: plain prose, not one of the coded values the 403s carry. ' +
      'This is the one place the contract uses that field the way RFC 6749 defines it — ' +
      'human-readable text for the developer rather than a value to branch on.',
  };
};

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

  // Federated: the generic handoff capability, or a native-social action for a strategy this
  // connection actually exposes.
  const feds = federatedConnections(conn);
  return (
    any('authn:federated:v1') ||
    feds.some((fc) => NATIVE_SOCIAL_ACTIONS[fc.strategy] && any(NATIVE_SOCIAL_ACTIONS[fc.strategy]))
  );
}

/** The initiate call. */
export function initiate(state, payload = {}) {
  if (!state.connection) return badRequest("data must have required property 'connection'");

  // PKCE is what makes a request_uri legal to return later — the draft forbids issuing one to a
  // client that never sent a code_challenge. Captured here, at the only call that can carry it.
  if (payload.code_challenge) state.codeChallenge = String(payload.code_challenge);

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
        'initiate rather than leading you into a dead end. Declaring more capabilities, or enabling ' +
        'another method on the connection, is what opens this up.',
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
  const next = attachPathAHref(state, offered, nextFromOffered(offered));
  state.next = next;

  // Path A opened a browser leg on this very response, so it answers redirect_to_web like any
  // other handoff rather than the ordinary continuation the non-federated cases get.
  const res = state.webLeg?.browser
    ? webLegContinuation(
        state,
        next.find((n) => n.action === state.webLeg.action) ?? next[0],
        `Path A. ${state.webLeg.connectionName} is the only eligible federated connection, so the ` +
          'server resolved it without asking and the href is already here — one round-trip instead ' +
          'of two. Open it, then resume on the same action; the deep link back carries nothing.'
      )
    : (() => {
        const r = continuation(state, next);
        r.note =
          `Capability negotiation is an intersection: an action is offered only if this connection ` +
          `supports it AND the client declared it. ${offered.length} came back` +
          (withheld.length ? `, ${withheld.length} were withheld` : '') +
          '. That `next` array is also the server-side allow-list — the following call has to name ' +
          'one of the actions in it, and nothing else will be accepted.';
        return r;
      })();

  // webLegContinuation narrows `next` to the one descriptor it built; for Path A that is the only
  // federated action, and there is nothing else on offer, so restore the full array either way.
  res.body.next = next;
  state.next = next;
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

  // Before anything else: is this session even ours? Checked ahead of the allow-list, because
  // the allow-list only means something for a session the server actually issued.
  const badSession = checkSession(state, payload.auth_session);
  if (badSession) return badSession;

  if (!allowed.includes(action)) {
    // D2 decision #3: `next` is both the response and the server-side allow-list the inbound
    // action is validated against. Refusing is the whole point of the contract.
    //
    // This is the END STATE, so it answers invalid_request. The tenant returns a 500 server_error
    // here today; that deviation is recorded in KNOWN_GAPS for the contract view rather than
    // reproduced, because a simulator of the finished protocol should not teach a bug as if it
    // were the design.
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: `"${action}" is not one of the actions currently offered.`,
        // The refusal changed nothing, so the allow-list still stands and is restated — the client
        // can correct the action and carry on without restarting. Contrast invalid_session, which
        // cannot echo `next`: handing back a usable session there would defeat the rejection.
        auth_session: state.authSession,
        next: state.next,
      },
      note:
        `"${action}" is not in the current next allow-list [${allowed.join(', ') || 'empty'}], so ` +
        'the server refuses it. The allow-list is what stops a client skipping a step — jumping ' +
        'straight to verify without a challenge, or submitting a credential the connection never ' +
        'offered. Nothing about the session changed: fix the action and continue.',
    };
  }

  // Connection-specialised federation actions are minted per negotiation, so they cannot be
  // `case` labels. The allow-list above already proved this one was offered.
  if (isFederatedAction(action)) return doFederated(state, action, payload);

  switch (action) {
    case 'action:signup:v1': {
      state.intent = 'signup';
      const { offered, withheld } = negotiate(state);
      const next = nextFromOffered(offered.filter((o) => o.id.startsWith('action:identify:')));
      state.next = next;
      const res = continuation(state, next);
      res.negotiation = { offered, withheld };
      res.note =
        'Session intent switched to signup. `next` narrows to the identify actions — everything ' +
        'else waits until there is an identifier to attach it to. Note the response shape is the ' +
        'same one sign-in returns: an observer cannot tell which of the two is happening, which ' +
        'is the point.';
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

    case 'action:enroll:password:v1':
      return doEnrollPassword(state, payload);

    case 'action:signup:confirm:v1': {
      const res = complete(state);
      res.note =
        'Signup confirmed — the user record is created HERE, not at identify. Everything before ' +
        'this was held in the session, so an abandoned signup leaves nothing behind. The code is ' +
        'the same authorization_code a sign-in issues; exchange it at POST /oauth/token with the ' +
        'standard grant.';
      return res;
    }

    case 'authn:ns:google:v1':
    case 'authn:ns:apple:v1':
    case 'authn:ns:facebook:v1':
      return doNativeSocial(state, action, payload);

    case 'action:interaction:captcha:verify:v1':
      return doCaptchaVerify(state, payload);

    case 'action:interaction:web:v1':
      return doWebInteraction(state, payload);

    // DECIDED: a leg resumes on the action it was offered under. FORMS resumes on
    // action:interaction:form:verify:v1, which the server never advertises; that id is retired.
    case 'action:interaction:form:v1':
      return doFormVerify(state, payload);

    default:
      return {
        status: 501,
        body: { error: 'not_implemented', error_description: `No handler registered for ${action}.` },
        note: unimplementedNote(action),
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

  if (!value) return badRequest(`Missing "${field}".`, state);
  if (field === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return badRequest('Invalid email format.', state);
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

  // BOT, Adaptive mode: the challenge fires after the identifier is established and BEFORE any
  // credential action, whichever factor would have come next. The user proves humanness once and
  // the rest of the flow stays in-app.
  if (state.botDetection === 'adaptive' && !state.captchaCleared) {
    return emitCaptcha(
      state,
      'negotiate',
      'Bot risk exceeded the configured threshold, so the pipeline pauses before any credential is ' +
        'collected — Adaptive mode. Note what did NOT happen: no branch on whether the identifier ' +
        'resolved to a real user, because that would be an oracle.'
    );
  }

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

  // A second challenge on the channel that already has one outstanding is a RESEND, not a fresh
  // challenge. The distinction matters for exactly one reason: the wrong-code counter must
  // survive it. Reset it here and the attempt cap becomes unreachable — ask for a new code
  // between guesses and you can try forever. The real limiter is per-user in auth0-users, not
  // per-ticket, and the decoy counter mimics it at the same number.
  const resend = state.pendingChallenge?.type === 'otp' && state.pendingChallenge.channel === channel;
  const resends = resend ? (state.pendingChallenge.resends ?? 0) + 1 : 0;

  state.pendingChallenge = {
    type: 'otp',
    channel,
    masked: maskIdentifier(target || ''),
    // Real user: the users-service ticket id, held server-side only, never returned. A resend
    // issues a new ticket; the old code stops working.
    ticketId: state.user?.decoy ? undefined : 'otp_ticket_' + Math.random().toString(36).slice(2, 10),
    resends,
  };
  if (!resend) state.attempts = 0;

  const { offered, withheld } = negotiate(state);
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  res.note = state.user?.decoy
    ? 'DECOY: no code was sent and no ticket exists. The response time is padded to match a real ' +
      'send so latency does not leak existence — and the masked identifier is a mask of the address ' +
      'that was submitted, so even that looks normal.' +
      (resend ? ` Resend ${resends} — a decoy resends nothing, identically.` : '')
    : `Code sent over ${channel}. In spec mode the correct code is ${SPEC_OTP}. The users-service ` +
      'ticket id is sealed in action_state and never returned to the client.' +
      (resend
        ? ` This was a RESEND (${resends}) — the challenge stayed in \`next\` beside verify:otp, ` +
          'which is how the signup PRD models it. A fresh ticket was issued, so the previous code ' +
          `no longer works, and the wrong-code counter carried over at ${state.attempts}/` +
          `${MAX_OTP_ATTEMPTS} rather than resetting. D2 defers resend rate limits, so nothing ` +
          'caps how often this can be called — the anti-bombing gap, now reachable on purpose ' +
          'rather than only by replaying a session.'
        : '');
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
      : `Wrong code — spec mode accepts ${SPEC_OTP}. Recoverable: retry against the rotated ` +
        `session, or resend from the challenge action still on offer. Attempt ${state.attempts}/` +
        `${MAX_OTP_ATTEMPTS}. (The registry's example, 032252, is a real code from the verified ` +
        'tenant walk — it is what live mode should show, not something this simulator accepts.)';
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

/**
 * A dependency outage, which is NOT a credential failure.
 *
 * PWD: "A 5xx from auth0-users is a dependency outage, not a credential failure, and must surface
 * as a masked 500 server_error rather than being folded into invalid_identifier_or_password —
 * otherwise an outage looks like a wrong password and clients will retry into it."
 *
 * Note what this deliberately breaks: Decision 4 collapses six negative outcomes into one
 * indistinguishable response, and this is the seventh that must NOT join them. The dividing line
 * is whether the answer says something about the USER — wrong password, blocked account, breached
 * credential all do, and are masked — or about the SERVICE, which does not, and is not. The cost
 * is that a client, and therefore an attacker, can tell "the service is broken" from "your
 * password is wrong"; PWD accepts that without discussing it.
 *
 * The session is untouched: nothing is consumed, nothing rotates, and the same call can be retried
 * once the dependency recovers.
 */
function upstreamOutage(state, dependency) {
  return {
    status: 500,
    body: { error: 'server_error', error_description: 'An unexpected error occurred.' },
    note:
      `${dependency} returned a 5xx. This is masked to server_error rather than folded into the ` +
      'uniform credential failure, and the difference is the point: a client that sees ' +
      'invalid_identifier_or_password re-prompts the user and retries, which against an outage is ' +
      'exactly the wrong thing to do. No `next`, no rotated auth_session — nothing was consumed, ' +
      'so the same call can be repeated once the dependency recovers.\n\n' +
      'It is the one negative outcome the Password RFD does NOT collapse into the uniform ' +
      'response. Everything that says something about the user is masked; this says something ' +
      'about the service.',
  };
}

/**
 * The Attack Protection outcomes, and what each one would reveal if it were reported faithfully.
 *
 * All four are terminal and specific in the real system; all four are masked here. The two that
 * are account-specific could not be reported under any design without confirming the account
 * exists. The two that are not are the ones Open Question 4 proposes splitting out.
 */
const ATTACK_PROTECTION = {
  user_blocked: 'The account is blocked by brute-force protection (account-specific)',
  password_breached: 'The credential appears in a breach corpus (account-specific)',
  ip_blocked: 'The originating IP is blocked by suspicious-IP throttling (not account-specific)',
  same_user_login: 'Blocked by the same-user-login control (not account-specific)',
};

function doVerifyPassword(state, payload) {
  if (!payload.password) return badRequest('Missing "password".', state);
  if (payload.simulate === 'upstream_error') return upstreamOutage(state, 'auth0-users');

  // Attack Protection outcomes. Every one of these is a TRUE statement about an account that
  // exists — which is exactly why none of them may be reported. They are folded into the same
  // failure a typo produces by routing through the same branch below, so the bytes are identical
  // by construction rather than by two code paths agreeing.
  const blocked = ATTACK_PROTECTION[payload.simulate] ? payload.simulate : null;
  const correct = !blocked && !state.user?.decoy && payload.password === 'Abcd@1234';

  // BOT, Block mode: reject without exposing that bot detection fired at all. Identical to the
  // uniform credential failure below — that identity is the whole point.
  if (state.botDetection === 'block') {
    const { offered } = negotiate(state);
    state.next = nextFromOffered(offered);
    const res = continuation(state, state.next, 'invalid_identifier_or_password');
    res.note =
      'Block mode. The credential was ' +
      (correct ? 'CORRECT' : 'wrong') +
      ', and the response is the same either way — byte-identical to a failed login, so the client ' +
      'cannot distinguish "you are a bot" from "wrong password". Simplest mode to configure, and ' +
      'the one with no recourse: a false positive is a legitimate user silently locked out with no ' +
      'path forward.';
    return res;
  }

  // Every negative outcome collapses to one response — wrong password, decoy, blocked user,
  // blocked IP, breached password, custom-DB rejection.
  if (!correct) {
    // BOT: CAPTCHA clearance is consumed by the attempt, so a wrong password drops back to
    // captcha-required rather than to the credential step. Solve once, guess many is the exact
    // attack this closes.
    if (state.captchaCleared) {
      state.captchaCleared = false;
      return emitCaptcha(
        state,
        'negotiate',
        'Wrong password, and the CAPTCHA clearance was consumed by the attempt — so the session ' +
          'resets to captcha-required, NOT back to the credential step. Solve once and then spray ' +
          'passwords against the same session is precisely what this closes; every attempt costs ' +
          'another CAPTCHA.'
      );
    }
    const { offered } = negotiate(state);
    const next = nextFromOffered(offered);
    state.next = next;
    const res = continuation(state, next, 'invalid_identifier_or_password');
    res.note =
      'One uniform failure. Wrong password, unknown user, blocked user, blocked IP, breached ' +
      'password, and a custom-DB script rejection all produce exactly this — a deliberate loss of ' +
      'fidelity, because "user is blocked" is a true statement about an account that exists. ' +
      '`next` re-advertises every method still available, so the client can switch to OTP without ' +
      'restarting. (Spec mode accepts Abcd@1234.)' +
      (blocked
        ? `\n\nThe password submitted was CORRECT. ${ATTACK_PROTECTION[blocked]} — and the ` +
          'response is byte-identical to a typo, which is the whole design.\n\n' +
          'This is the Password RFD\'s Open Question 4, unresolved: masking uniformly "tells a ' +
          'legitimately-blocked user nothing and invites them to keep retrying against a lockout." ' +
          'The proposal on the table is to split them — a terminal access_denied for the outcomes ' +
          'that are NOT account-specific (ip-blocked, same-user-login) while continuing to mask ' +
          'the ones that are (user-blocked, password-breached). Nothing is decided, so everything ' +
          'is masked here.'
        : '');
    return res;
  }

  state.completedFactors.push('password');
  state.amrs.push({ name: 'pwd', timestamp: Date.now() });
  state.captchaCleared = false; // consumed on success too — single-use means single-use.

  // BOT, Customize with Actions: the Action evaluates the bot signal in the post-login pipeline,
  // so it fires AFTER the credential was submitted, and can hand off to the same hosted CAPTCHA
  // via api.botDetection.challenge().
  if (state.botDetection === 'actions') {
    return emitCaptcha(
      state,
      'afterFactor',
      'A post-login Action read event.authentication.riskAssessment.assessments.BotDetection and ' +
        'called api.botDetection.challenge(), handing off to the same hosted CAPTCHA the Adaptive ' +
        'mode uses. The timing is the trade-off: the password was already collected before the ' +
        'Action could evaluate anything. The customer gets full signal control and takes on ' +
        'responsibility for keeping the deny path indistinguishable from a credential failure.'
    );
  }

  return afterFactor(state, 'Password verified through the same /wsfed/direct call and AnomalyDetection chain Universal Login uses.');
}

function doVerifyRecoveryCode(state, payload) {
  if (!payload.recovery_code) return badRequest('Missing "recovery_code".', state);
  if (String(payload.recovery_code).length < 8) {
    const { offered } = negotiate(state);
    state.next = nextFromOffered(offered);
    const res = continuation(state, state.next, 'invalid_code');
    res.note =
      'Rejected, and note the code: invalid_code, not the invalid_identifier_or_* pair the ' +
      'credential paths share. A recovery code identifies nobody — there is no identifier half to ' +
      'be ambiguous about — so the deliberate vagueness those values carry would say nothing here. ' +
      'Recoverable: the same `next` comes back.';
    return res;
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
 * Why a given action has no handler. Three different reasons hide behind one 501, and reporting
 * them as the same thing is how "not implemented" stops meaning anything.
 */
function unimplementedNote(action) {
  if (action === 'authn:federated:v1') {
    return (
      'This is the GENERIC capability a client declares. The server never offers it back — it ' +
      'answers with one connection-specialised action per eligible connection ' +
      '(authn:federated:<connection>:v1), and those are handled. Submitting the generic id is a ' +
      'client bug, not a missing feature.'
    );
  }
  if (action === 'action:interaction:form:native:v1') {
    return (
      'Client-declared capability, not a server action. Declaring it changes the shape of the ' +
      'action:interaction:form:v1 descriptor — form_id + state instead of an href — but it is ' +
      'never something the client invokes.'
    );
  }
  if (action.startsWith('authn:passkey:')) {
    return (
      'Genuinely unimplemented here: the passkey sources (RAPID, Milestone 1) are cited in the ' +
      'registry but are not among the specs committed to this repo, so there is nothing to build ' +
      'a faithful handler from. The request/response shapes would have to be invented, which is ' +
      'exactly what this playground exists not to do. Naming is unsettled in the docs too — ' +
      'authn:passkey:v1, action:authn:passkey:v1 and action:login:passkey:v1 all appear.'
    );
  }
  if (action === 'action:identify:phone:v1') {
    return (
      'The capability negotiates and is advertised in `next`, but no handler exists — the gap the ' +
      'Password RFD calls out in its non-goals.'
    );
  }
  return 'No handler is registered for this action in the simulator.';
}

/* ─────────────────── escape-to-web: federation, CAPTCHA, forms, redirects ───────────────────
   All four cases share one architecture (REDIR, "The Common Architecture"): the server pauses,
   hands back an href pointing at a coordination reference, the user does something in a browser,
   the callback carries NOTHING, and the app resumes by posting the same auth_session back. What
   differs between them is only the TTL, the binding controls, and which action resumes. */

/**
 * A `next` descriptor for an open web leg.
 *
 * `expires_in` is the draft's own OPTIONAL parameter for the lifetime of the reference, in
 * seconds. The TTLs already exist per case; without this they never leave Redis, so a client
 * cannot tell an expired href from a broken one.
 */
function webLegDescriptor(leg, fields) {
  return { action: leg.action, ...fields, expires_in: leg.ttlSeconds };
}

/**
 * The browser leg, described.
 *
 * Everything here happens between two `/e/authorize` calls and none of it is visible to the
 * client — no HTTP it makes, no header it reads. The transcript would otherwise show an href
 * followed by a resume that inexplicably works, which is the single most confusing thing about
 * this pattern. Each entry says what the app does, what the user does, what the server does, and
 * what comes back on the deep link (always: nothing).
 */
const HANDOFFS = {
  federation: (leg) => ({
    title: 'The browser leg — federation',
    opens: 'ASWebAuthenticationSession / Chrome Custom Tabs on the href above',
    steps: [
      `Auth0 looks up ${leg.requestUri} to find the connection and nonce, then redirects to ${leg.connectionName}.`,
      'The user is asked to authenticate with the identity provider. PKCE, state and nonce are all ' +
        'generated server-side — the app never sees them.',
    ],
    callback: 'myapp://callback',
    resume: leg.action,
  }),
  captcha: (leg) => ({
    title: 'The browser leg — CAPTCHA',
    opens: 'a system browser on the href above',
    steps: [
      `The page validates ${leg.requestUri} against the record: still PENDING, and the request IP ` +
        `and ASN match (${leg.ip} / ${leg.asn}).`,
      'The user is shown the challenge. If they solve it the browser POSTs the result straight to ' +
        'Auth0 — same origin, no redirect — and Auth0 validates it with the CAPTCHA provider.',
    ],
    callback: 'myapp://captcha-done',
    resume: leg.action,
  }),
  form: (leg) => ({
    title: 'The browser leg — hosted form',
    opens: 'a WebView on the href above',
    steps: [
      "Auth0's hosted form page loads the same Auth0Forms SDK Universal Login uses.",
      `The user is asked to fill in and submit the form; the SDK posts it to the DX Flows API ` +
        `against journey ${leg.journeyId}.`,
    ],
    callback: 'myapp://callback',
    resume: leg.action,
  }),
  web: (leg) => ({
    title: 'The browser leg — Actions redirect',
    opens: 'a browser on the href above',
    steps: [
      `Auth0 /continue validates ${leg.requestUri} and redirects to ${leg.redirectTo}, passing the ` +
        'reference as `state`.',
      'The customer endpoint does whatever it does, then calls /continue back with that same state.',
    ],
    callback: 'myapp://callback',
    resume: leg.action,
  }),
};

/**
 * How the leg that just ended turned out.
 *
 * Attached to the response that RESUMES, not the one that opened the leg — the opening response
 * cannot know. Getting this wrong is visible: an interstitial that says "the user authenticated
 * and the record is COMPLETE" followed by a response explaining they closed the browser.
 */
const legOutcome = (state, detail) => ({ state, detail });

const COMPLETED = {
  federation: 'Auth0 /callback decoded the opaque value, exchanged the IdP code, and stored the IdP ' +
    'tokens in the token vault. The record is COMPLETE.',
  captcha: 'The user solved the challenge and Auth0 validated it with the provider. The record ' +
    'flipped PENDING → SOLVED.',
  form: 'The user submitted the form and the DX Flows journey reached COMPLETED. The POST handler ' +
    'detected the embedded context and deep-linked back instead of rendering the next UL prompt.',
  web: 'The customer endpoint finished and called /continue back. Auth0 detected the embedded ' +
    'context and advanced the session.',
};

/**
 * The response that opens or re-opens a web leg.
 *
 * DECIDED: a leg that sends the user to a browser answers with `redirect_to_web` and the
 * coordination reference at the top level — the draft's own shape for this, and the case its
 * usage text names: "The authorization server may choose to interact directly with the user based
 * on a risk assessment, the introduction of a new authentication method not supported in the
 * application, or to handle an exception flow such as account recovery."
 *
 * A leg rendered in-app never opens a browser — the native Forms SDK path — so it stays an
 * ordinary continuation. `redirect_to_web` is the signal "you must leave the app"; emitting it
 * where nothing leaves the app would make the code meaningless.
 */
function webLegContinuation(state, entry, note) {
  state.next = [entry];
  const leg = state.webLeg;

  if (!leg?.browser) {
    const res = continuation(state, state.next);
    res.note = note;
    return res;
  }

  const body = { error: 'redirect_to_web' };
  // The draft is strict: "If the client does not include a PKCE code_challenge in the initial
  // authorization challenge request, the authorization server MUST NOT return a request_uri in
  // the redirect_to_web error response, as that would effectively be the same as a PAR request
  // without PKCE." Withheld rather than refused — the draft's own fallback is that a client with
  // no request_uri starts a fresh authorization code flow with PKCE itself.
  if (state.codeChallenge) body.request_uri = leg.requestUri;
  body.auth_session = rotate(state);
  body.next = state.next;

  return {
    status: 403,
    body,
    // What happens between this response and the next request. None of it is HTTP the client can
    // see, which is exactly why the transcript needs to say it: without this the resume looks like
    // it succeeds for no reason.
    handoff: HANDOFFS[leg.kind](leg),
    note:
      note +
      (state.codeChallenge
        ? ''
        : '\n\nNOTE: no request_uri on this response. The initiate call carried no PKCE ' +
          'code_challenge, and the draft forbids returning one without it — that would be a PAR ' +
          'request without PKCE. The href still works; a draft-only client would fall back to ' +
          'starting its own authorization code flow. Add code_challenge at initiate to see it.'),
  };
}

/**
 * Abandonment and recovery, identical for every web leg: the app closed the WebView, the device
 * went offline, or the TTL lapsed. REDIR is explicit that the server does NOT ask the client to
 * remember the old href or request_uri — it mints a fresh reference and answers with the same
 * action, "indistinguishable from the original response".
 */
function reissueWebLeg(state, buildEntry, why) {
  const old = state.webLeg;
  const fresh = openWebLeg(state, { ...old, status: 'PENDING' });
  const res = webLegContinuation(
    state,
    buildEntry(fresh),
    `${why} A fresh coordination reference was minted (${old.requestUri} → ${fresh.requestUri}) and ` +
      'the same action comes back. The client never had to remember the old one — recovery is ' +
      'possible until the auth_session itself expires.'
  );
  // The leg that just ended did not complete. Said here so the interstitial above this response
  // stops claiming it did.
  res.legOutcome = legOutcome('abandoned', `${why} Nothing was stored, and the old reference is dead.`);
  return res;
}

const federationHref = (leg) => `${TENANT}/authorize?request_uri=${leg.requestUri}`;
const captchaHref = (leg) => `${TENANT}/captcha?request_uri=${leg.requestUri}`;
const formHref = (leg) => `${TENANT}/form?request_uri=${leg.requestUri}`;
const webHref = (leg) =>
  `${TENANT}/continue?request_uri=${leg.requestUri}&redirect_to=${encodeURIComponent(leg.redirectTo)}`;

/** A user established by an external IdP rather than by identify + factor. */
function federatedUser(state, label, identifier) {
  state.userIdentified = true;
  state.user = {
    user_id: `auth0|${label}-${RANDOM_REF()}`,
    email: identifier,
    username: null,
    phone_number: null,
    hasPassword: false,
    // Nothing enrolled: an IdP-authenticated user who has never set up MFA here. With policy
    // Always this reaches no_eligible_factors, which is the honest outcome.
    enrolledFactors: [],
    identifier,
    identifierType: 'email',
    decoy: false,
  };
}

/**
 * Federation. Path A arrived with its href already attached at initiate, so the first call here
 * is the resume. Path B has no reference yet, so the first call is the client's CHOICE and the
 * answer is redirect_to_web — the one place the protocol uses that error code.
 */
function doFederated(state, action, payload) {
  const connectionName = connectionOfFederatedAction(action);
  const leg = state.webLeg;
  const open = leg && leg.kind === 'federation' && leg.connectionName === connectionName;

  if (!open) {
    const fresh = openWebLeg(state, { kind: 'federation', browser: true, action, connectionName });
    return webLegContinuation(
      state,
      webLegDescriptor(fresh, { href: federationHref(fresh) }),
      `Path B, second call. The client echoed ${action} to say which connection the user picked, ` +
        'and only now does the server mint a coordination reference. ' +
        `The record is Redis-side: { auth_session_ref, connection: ${connectionName}, ` +
        `status: PENDING, ttl: ${fresh.ttlSeconds}s }. The opaque value travels to the IdP inside ` +
        'the OAuth2 `state` (or SAML RelayState) — Auth0 generates PKCE, nonce and the rest ' +
        'server-side; the app never sees them.'
    );
  }

  if (payload.simulate === 'abandoned' || payload.simulate === 'expired') {
    return reissueWebLeg(
      state,
      (fresh) => webLegDescriptor(fresh, { href: federationHref(fresh) }),
      payload.simulate === 'expired'
        ? `The ${leg.ttlSeconds}s coordination reference expired before the IdP round-trip finished.`
        : 'The user closed the WebView without completing the IdP login.'
    );
  }

  state.webLeg = null;
  federatedUser(state, connectionName, 'alice@company.com');
  state.completedFactors.push('federated');
  state.amrs.push({ name: 'federated', timestamp: Date.now(), type: connectionName });

  const done = afterFactor(
    state,
    `Resumed after the browser leg. Auth0 /callback had already decoded the opaque value, exchanged ` +
      `the IdP code, and stored the IdP tokens in the token vault — so this call carries no artifact ` +
      `at all, just the auth_session and the same ${action} it was offered under. The deep link that ` +
      'brought the user back carried nothing either: "Callbacks carry no tokens."'
  );
  done.legOutcome = legOutcome('completed', COMPLETED.federation);
  return done;
}

/**
 * Native social. Not an escape-to-web case at all — no href, no browser, no coordination
 * reference. The app talks to the provider SDK directly and posts the artifact back.
 */
function doNativeSocial(state, action, payload) {
  const provider = action.slice('authn:ns:'.length, -':v1'.length);
  const expectedType = ARTIFACT_TYPE_BY_PROVIDER[provider];

  // DECIDED: idp_artifact + idp_artifact_type. `id_token` — REDIR's worked example — is still
  // read so the documented request does not simply fail, but it is answered with the correction
  // rather than accepted silently.
  const artifact = payload.idp_artifact ?? payload.id_token;
  if (!artifact) return badRequest('Missing "idp_artifact".', state);

  const usedLegacyName = payload.idp_artifact == null;
  const type = payload.idp_artifact_type;

  if (!type && !usedLegacyName) {
    return badRequest(
      `Missing "idp_artifact_type". ${provider} returns ${expectedType} — the type travels with ` +
        'the artifact rather than being inferred from the action id.',
      state
    );
  }
  if (type && type !== expectedType) {
    return badRequest(
      `"idp_artifact_type" is ${type}, but ${provider} returns ${expectedType}.`,
      state
    );
  }

  federatedUser(state, `ns-${provider}`, 'alice@example.com');
  state.completedFactors.push('federated');
  state.amrs.push({ name: 'federated', timestamp: Date.now(), type: `ns:${provider}` });

  return afterFactor(
    state,
    `Native ${provider} SDK path — no WebView, no browser, no coordination reference. The artifact ` +
      `is typed ${expectedType}: ` +
      (provider === 'apple'
        ? 'Apple returns an authorization code, which is why no token-shaped field name works ' +
          'across all three providers, and why this URN stays proprietary — RFC 8693 has no ' +
          'registered equivalent for it.'
        : 'an access token, under RFC 8693\'s registered URN rather than an Auth0-minted one.') +
      (usedLegacyName
        ? ' NOTE: sent as `id_token`, which is what REDIR\'s worked example shows. That name is ' +
          'retired — it describes neither an access token nor an authorization code. Send ' +
          'idp_artifact + idp_artifact_type.'
        : '')
  );
}

/* ── bot detection (BOT) ─────────────────────────────────────────────────── */

const CAPTCHA_IP = '203.0.113.42';
const CAPTCHA_ASN = 'AS15169';

/**
 * Open a CAPTCHA challenge. `onSolved` records where the pipeline goes next, because the two
 * response modes fire at different points: Adaptive before any credential is submitted,
 * Customize-with-Actions after one already has been.
 */
function emitCaptcha(state, onSolved, why) {
  const leg = openWebLeg(state, {
    kind: 'captcha',
    browser: true,
    action: 'action:interaction:captcha:verify:v1',
    ip: CAPTCHA_IP,
    asn: CAPTCHA_ASN,
    onSolved,
  });
  return webLegContinuation(
    state,
    webLegDescriptor(leg, { href: captchaHref(leg) }),
    `${why} The Redis record is { auth_session_ref, status: PENDING, ip: ${CAPTCHA_IP}, ` +
      `asn: ${CAPTCHA_ASN}, ttl: ${leg.ttlSeconds}s } — the request_uri itself carries nothing, so ` +
      'the URL is worthless on another machine: the CAPTCHA page revalidates IP/ASN on load. The ' +
      'callback is a bare myapp://captcha-done with no token in it.'
  );
}

function doCaptchaVerify(state, payload) {
  const leg = state.webLeg;
  if (!leg || leg.kind !== 'captcha') return badRequest('No CAPTCHA challenge is open.', state);

  if (payload.simulate === 'failed' || payload.simulate === 'expired') {
    return reissueWebLeg(
      state,
      (fresh) => webLegDescriptor(fresh, { href: captchaHref(fresh) }),
      payload.simulate === 'expired'
        ? `The ${leg.ttlSeconds}s record expired, or the IP/ASN no longer matched.`
        : 'The user failed or cancelled the CAPTCHA (myapp://captcha-done?error=captcha_failed).'
    );
  }

  const { onSolved } = leg;
  state.webLeg = null;
  state.captchaCleared = true;
  state.boundIp = `${leg.ip} (${leg.asn})`;

  const solvedNote =
    'CAPTCHA cleared. Two bindings land at exactly this moment, and they are the point of the ' +
    `design: the validating IP/ASN is stamped onto the auth_session (${state.boundIp}), so a ` +
    'clearance farmed on one network cannot be driven from another; and the clearance is marked ' +
    'SINGLE-USE, consumed by the next credential attempt. The Redis record is deleted now, not ' +
    'left to expire.';

  if (onSolved === 'afterFactor') {
    const done = afterFactor(state, solvedNote);
    done.legOutcome = legOutcome('completed', COMPLETED.captcha);
    return done;
  }

  const { offered, withheld } = negotiate(state);
  const next = nextFromOffered(offered);
  state.next = next;
  const res = continuation(state, next);
  res.negotiation = { offered, withheld };
  res.note = `${solvedNote} The credential flow now continues natively — no further browser step.`;
  res.legOutcome = legOutcome('completed', COMPLETED.captcha);
  return res;
}

/* ── post-login Actions: forms and redirects (FORMS, REDIR) ──────────────── */

/**
 * Authentication is done; a post-login Action wants a web leg before the code is issued.
 *
 * Forms have two render paths off one action id. Declaring
 * action:interaction:form:native:v1 swaps the descriptor from href-to-WebView over to
 * form_id + state for the native SDK — the journey, the binding and the resume check are
 * identical either way.
 */
function emitPostLogin(state, note) {
  if (state.postLogin === 'form') {
    const native = state.declaredCaps.includes('action:interaction:form:native:v1');
    const leg = openWebLeg(state, {
      kind: 'form',
      // The native SDK renders inline; only the hosted-page path opens a browser.
      browser: !native,
      action: 'action:interaction:form:v1',
      formId: `form_${RANDOM_REF()}`,
      journeyId: RANDOM_REF(),
      native,
    });
    // DECIDED: journey_id, not `state` — RFC 6749 already owns that word, and REDIR argues
    // against reusing it for the coordination reference on exactly these grounds.
    const entry = native
      ? webLegDescriptor(leg, { form_id: leg.formId, journey_id: leg.journeyId })
      : webLegDescriptor(leg, { href: formHref(leg) });

    return webLegContinuation(
      state,
      entry,
      `${note} A post-login Action called api.prompt.render(), so the pipeline pauses again — ` +
        'after authentication, before the code. One dxFlowsApi.createJourney() call created the ' +
        `journey, bound to ${leg.journeyId} — the value DX Flows stores as its \`state\`, but sent ` +
        'on the wire as journey_id so it does not collide with the OAuth parameter of that name. ' +
        (native
          ? 'The client declared action:interaction:form:native:v1, so the descriptor carries ' +
            'form_id + journey_id instead of an href and the Native Form SDK renders inline — no ' +
            'WebView, no form_token, no iron-seal. (Beta path; redirect-to-web is the production ' +
            'recommendation.)'
          : 'No native capability declared, so this is the redirect path: the href is Auth0\'s ' +
            'hosted form page, which loads the same Auth0Forms SDK Universal Login uses and ' +
            'deep-links back instead of rendering the next UL prompt. The app never touches the ' +
            'Forms SDK.') +
        ' Resume on this same action once the journey is COMPLETED.'
    );
  }

  const leg = openWebLeg(state, {
    kind: 'web',
    browser: true,
    action: 'action:interaction:web:v1',
    redirectTo: 'https://myapp.com/verify',
  });
  return webLegContinuation(
    state,
    webLegDescriptor(leg, { href: webHref(leg) }),
    `${note} A post-login Action called api.redirect.sendUserTo(). Auth0 /continue validates the ` +
      'request_uri and bounces to the customer URL with state=<request_uri>; the customer endpoint ' +
      'calls /continue back; Auth0 advances the session and deep-links to the app. The deep link ' +
      'carries no code — resume on this same action to get it.'
  );
}

function doFormVerify(state, payload) {
  const leg = state.webLeg;
  if (!leg || leg.kind !== 'form') return badRequest('No form journey is open.', state);

  if (payload.simulate === 'abandoned' || payload.simulate === 'expired') {
    return reissueWebLeg(
      state,
      (fresh) =>
        fresh.native
          ? webLegDescriptor(fresh, { form_id: fresh.formId, journey_id: fresh.journeyId })
          : webLegDescriptor(fresh, { href: formHref(fresh) }),
      'The form was abandoned. A NEW journey is created — no partial state is preserved, so the ' +
        'form is presented fresh.'
    );
  }

  state.webLeg = null;
  state.postLoginDone = true;

  const res = complete(state);
  res.note =
    `Journey verified: getJourney(tenant, ${leg.journeyId}).status === COMPLETED, form_id matches, ` +
    'and auth_session_ref matches the inbound session. Those checks are identical on both render ' +
    'paths. Resumed on action:interaction:form:v1 — the id that was offered — so the `next` ' +
    'allow-list needed no exception. FORMS documents action:interaction:form:verify:v1 here ' +
    'instead; that id is retired. Actions pipeline advanced, code issued.';
  // Only when there WAS a browser leg. The native SDK path renders inline, so there is no
  // interstitial for an outcome to attach to.
  if (leg.browser) res.legOutcome = legOutcome('completed', COMPLETED.form);
  return res;
}

function doWebInteraction(state, payload) {
  const leg = state.webLeg;
  if (!leg || leg.kind !== 'web') return badRequest('No web interaction is open.', state);

  if (payload.simulate === 'abandoned' || payload.simulate === 'expired') {
    return reissueWebLeg(
      state,
      (fresh) => webLegDescriptor(fresh, { href: webHref(fresh) }),
      'The redirect was abandoned. The customer endpoint will receive a NEW state and must not ' +
        'assume continuity with the earlier visit.'
    );
  }

  state.webLeg = null;
  state.postLoginDone = true;
  const res = complete(state);
  res.note =
    'Auth0 detected the embedded context on the /continue round-trip, advanced the session, and ' +
    'deep-linked back with nothing in the URL. The code is issued here, on the resume — not by ' +
    'the callback.';
  res.legOutcome = legOutcome('completed', COMPLETED.web);
  return res;
}

function doEnrollPassword(state, payload) {
  if (!payload.password) return badRequest('Missing "password".', state);
  if (String(payload.password).length < 8) {
    // Reuses the code PWD's enum already defines rather than inventing one. The fit is imperfect
    // and worth knowing: this value means "the credential was not accepted", and here the reason
    // is a policy rejection with no identifier involved at all. No source document names a code
    // for signup password policy, so the choice is to stay inside the enum rather than widen it.
    const res = continuation(state, state.next, 'invalid_identifier_or_password');
    res.note =
      'Rejected against the connection password policy. Recoverable — the same `next` is ' +
      're-offered, so the client can try another password without restarting the signup.\n\n' +
      'The error_description reuses invalid_identifier_or_password because that is what the ' +
      'schema enum allows. It reads oddly here — nothing is wrong with the identifier — but no ' +
      'document defines a policy-rejection code, and inventing one would put an unsourced string ' +
      'on the wire.';
    return res;
  }

  state.completedFactors.push('password');
  state.amrs.push({ name: 'pwd', timestamp: Date.now() });
  const next = [{ action: 'action:signup:confirm:v1' }];
  state.next = next;
  const res = continuation(state, next);
  res.note =
    'Password enrolled on the pending signup. It is set on the user record at confirm, not here — ' +
    'nothing is persisted until the signup is confirmed.';
  return res;
}

/**
 * After any factor completes: signup fork, then MFA policy, then post-login web legs, then finish.
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

  // Post-login Actions run after every factor and before the code — so a form or a redirect
  // pauses the pipeline a third time, on the far side of MFA.
  if (state.postLogin !== 'none' && !state.postLoginDone) return emitPostLogin(state, note);

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
      // The session carries only the OPAQUE reference; every binding detail lives in the Redis
      // record the reference points at, never in anything the client holds.
      web_leg: state.webLeg
        ? {
            request_uri: state.webLeg.requestUri,
            kind: state.webLeg.kind,
            status: state.webLeg.status,
            ttl_seconds: state.webLeg.ttlSeconds,
          }
        : null,
      captcha_clearance: state.captchaCleared
        ? { single_use: true, bound_to: state.boundIp }
        : null,
    },
    amrs: state.amrs,
    jti: `spec-jti-${state.rotations}`,
    iat: '<issued at>',
    exp: '<+15 min>',
  };
}
