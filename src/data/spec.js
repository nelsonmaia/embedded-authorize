/**
 * spec.js — the Embedded Authorize contract, as data.
 *
 * Everything the playground knows about /e/authorize lives here: capability ids, request
 * fields, `next` descriptor shapes, error vocabulary, and where each came from.
 *
 * `status` is the honest state of each capability, not the aspiration:
 *   'live'            verified working against a real tenant (nelson.jp.auth0.com, 2026-09-01)
 *   'negotiated'      tenant advertises it in `next`, but no handler exists → 501
 *   'spec'            documented in an RFD, not implemented
 *
 * Sources are cited so a reader can go argue with the RFD, not with this file.
 */

export const VERIFIED_AGAINST = {
  tenant: 'nelson.jp.auth0.com',
  date: '2026-09-01',
  note: 'Email OTP loop walked end to end with curl; shapes below are copied from real responses.',
};

const DRAFT_URL = 'https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/';

/**
 * Native-social artifact types.
 *
 * RFC 8693 (Token Exchange) already registers a URN for an access token, so the two providers
 * that return one use it rather than a parallel Auth0-namespaced string. Apple's authorization
 * code has no registered equivalent, so it keeps the proprietary URN REDIR already documents.
 */
export const ARTIFACT_TYPES = {
  accessToken: 'urn:ietf:params:oauth:token-type:access_token',
  appleAuthzCode: 'http://auth0.com/oauth/token-type/apple-authz-code',
};

/** Which artifact type each native-social strategy hands back. */
export const ARTIFACT_TYPE_BY_PROVIDER = {
  google: ARTIFACT_TYPES.accessToken,
  facebook: ARTIFACT_TYPES.accessToken,
  apple: ARTIFACT_TYPES.appleAuthzCode,
};

export const SOURCES = {
  M1: { label: 'Milestone 1 plan', id: '884116723' },
  D2: { label: 'RFD Delivery 2 — Email OTP', id: '973309677' },
  D3: { label: 'RFD Delivery 3 — Chain steps + MFA', id: '1064011211' },
  PWD: { label: 'RFD Password as first factor', id: '1035207250' },
  DISCO: { label: 'RFD Embedded Flow Discovery', id: '1025054893' },
  BOT: { label: 'Bot Detection Challenge', id: '1040944724' },
  FORMS: { label: 'Forms Integration', id: '1045602836' },
  REDIR: { label: 'Redirect to Web Flows', id: '1046249511' },
  NEG: { label: 'Protocol Negotiation', id: '1046347787' },
  SIGNUP: { label: 'PRD Embedded Authorize — Signup', id: '1068894784' },
  RAPID: { label: 'RAPID challenge/verify action model', id: '1076202754' },
  DRAFT: { label: 'draft-ietf-oauth-first-party-apps-04', id: null, url: DRAFT_URL },
};

/** The IETF draft /e/authorize implements. Revision -04, 1 July 2026. */
export const DRAFT = {
  id: 'draft-ietf-oauth-first-party-apps-04',
  url: DRAFT_URL,
  revision: '04',
  date: '2026-07-01',
  note:
    'The normative floor. Where this draft speaks, it wins — the RFDs are Auth0 layered on top of ' +
    'it. Where it is silent (action vocabulary, the `next` array, capability negotiation) the ' +
    'decisions below are ours, and it says so explicitly: "These new error codes are specific to ' +
    'the authorization server\'s implementation of this specification and are intentionally left ' +
    'out of scope."',
};

export const confluenceUrl = (id) =>
  `https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/${id}`;

/* ────────────────────────────────────────────────────────────────────────────
   THE ENDPOINT

   Two request shapes on one path. The first call opens a session; every call after it names an
   action from the previous response's `next`. Nothing else is accepted.
   ──────────────────────────────────────────────────────────────────────────── */

export const ENDPOINT = {
  method: 'POST',
  path: '/e/authorize',
  contentType: 'application/json',

  /** The opening call. No auth_session yet — this is what creates one. */
  initiate: [
    { name: 'client_id', required: true, doc: 'The public client. No secret: these are public clients by definition.' },
    {
      name: 'connection',
      required: true,
      doc: 'Connection NAME. Required on every initiate — there is no tenant default, and the server will not pick one.',
    },
    {
      name: 'capabilities',
      required: true,
      doc:
        'What the client can do. Negotiation is an intersection of this and what the connection ' +
        'supports, so declaring less narrows what you can be asked to do — and declaring nothing ' +
        'usable is a 400 rather than a dead end later.',
    },
    {
      name: 'code_challenge',
      required: false,
      doc:
        'PKCE. Optional to start a flow, but REQUIRED to receive a request_uri on a redirect_to_web ' +
        'response — the draft forbids issuing one without it. Send it if any of your connections ' +
        'may hand off to a browser.',
    },
    { name: 'code_challenge_method', required: false, doc: 'S256.' },
    { name: 'scope', required: false, doc: 'Standard OAuth scope, carried through to the issued code.' },
    { name: 'audience', required: false, doc: 'Standard Auth0 audience.' },
    {
      name: 'identifier',
      required: false,
      doc:
        'An email or phone known up front. Lets Home Realm Discovery resolve a federated connection ' +
        'on this call rather than after an identify step.',
    },
  ],

  /** Every subsequent call. */
  continue: [
    {
      name: 'auth_session',
      required: true,
      doc:
        'From the MOST RECENT response. Each accepted request burns the value it was presented ' +
        'with, so a replayed one is invalid_session.',
    },
    {
      name: 'action',
      required: true,
      doc:
        'One of the ids in the previous response\'s `next`. That array is the server-side ' +
        'allow-list, not a hint — anything else is refused.',
    },
    {
      name: '…the action\'s own fields',
      required: false,
      doc: 'Per action, listed in the action reference below. Most take none.',
    },
  ],
};

/* ────────────────────────────────────────────────────────────────────────────
   CAPABILITIES

   `request`  — fields the client sends when invoking the action
   `emits`    — extra fields the server puts on the `next` descriptor
   ──────────────────────────────────────────────────────────────────────────── */

export const CAPABILITIES = [
  /* ---- identify ---------------------------------------------------------- */
  {
    id: 'action:identify:email:v1',
    group: 'identify',
    label: 'Identify by email',
    status: 'live',
    source: 'D2',
    request: [{ name: 'email', example: 'hazel.nutt@okta.com', required: true }],
    emits: [{ name: 'optional', value: 'true when the step may be skipped' }],
    doc:
      'Resolves whether the user exists, via auth0-users, and seals the result into the session ' +
      '(user_id + identifiers, or decoy:true). Returns the SAME `next` either way — this is the ' +
      'anti-enumeration guarantee. No code is sent at this step.',
  },
  {
    id: 'action:identify:phone:v1',
    group: 'identify',
    label: 'Identify by phone',
    status: 'negotiated',
    source: 'PWD',
    request: [{ name: 'phone_number', example: '+15551234567', required: true }],
    emits: [{ name: 'optional', value: 'true when the step may be skipped' }],
    doc:
      'The capability negotiates and appears in `next`, but no handler is registered — it ' +
      'resolves to 501 not_implemented. Called out explicitly as a pre-existing gap in the ' +
      'Password RFD non-goals. Consequence: on a connection whose only identifier is phone, ' +
      'embedded login is unreachable.',
  },
  {
    id: 'action:identify:username:v1',
    group: 'identify',
    label: 'Identify by username',
    status: 'spec',
    source: 'PWD',
    request: [{ name: 'username', example: 'hazelnutt', required: true }],
    emits: [],
    doc:
      'Gated on `username` being an active identifier. Only becomes useful once password lands — ' +
      'there is no username_otp, so a username-identified user would otherwise hit a dead end. ' +
      'Deliberately a separate path from identify:email: the server trusts the action it was ' +
      'given and does not normalise an email-shaped username to a canonical type.',
  },

  /* ---- primary factors --------------------------------------------------- */
  {
    id: 'action:challenge:email:v1',
    group: 'challenge',
    label: 'Challenge — email OTP',
    status: 'live',
    source: 'D2',
    request: [],
    emits: [
      { name: 'index', value: '0' },
      { name: 'identifier', value: '<masked>' },
    ],
    doc:
      'Sends the code for a real user. For a decoy it sends nothing and pads the response time ' +
      '(OTP_CHALLENGE_MIN_RESPONSE_TIME_MS) so latency does not leak existence. Both paths return ' +
      'an identical descriptor, including a masked identifier — the decoy gets a mask of the ' +
      'address it submitted. Reused unchanged as an MFA challenge in D3.\n\n' +
      'It stays in `next` while its own code is outstanding, alongside verify:otp, so the user can ' +
      'ask for another one — all 36 signup responses that offer verify:otp re-offer the challenge ' +
      'beside it, and sign-in matches. The descriptor is identical on a resend; it is not a ' +
      'separate shape. A resend issues a new ticket (the old code stops working) and deliberately ' +
      'does NOT reset the wrong-code counter, or the attempt cap could be dodged by asking for a ' +
      'fresh code between guesses. Nothing rate-limits it — D2 defers anti-bombing entirely.',
  },
  {
    id: 'action:verify:otp:v1',
    group: 'verify',
    label: 'Verify — OTP code',
    status: 'live',
    source: 'D2',
    request: [{ name: 'otp', example: '032252', required: true }],
    emits: [
      { name: 'channel', value: 'email' },
      { name: 'identifier', value: '<masked>' },
    ],
    doc:
      'On success the orchestrator resumes the paused TDE pipeline, which reaches consent then ' +
      'grant/code.js and issues a real authorization code. A wrong code is RECOVERABLE: same 403 ' +
      'shape, error_description invalid_identifier_or_code, retry against the rotated session. ' +
      'A decoy is rejected with no users-service call at all — byte-identical to a wrong code.',
  },
  {
    id: 'action:verify:password:v1',
    group: 'verify',
    label: 'Verify — password',
    status: 'spec',
    source: 'PWD',
    request: [{ name: 'password', example: 'Abcd@1234', required: true, secret: true }],
    emits: [],
    doc:
      'Verification-only — no challenge step, because the credential already exists on the client. ' +
      'Goes through the same /wsfed/direct call and the same AnomalyDetection chain as the ' +
      'Universal Login password prompt, so brute-force and breached-password behaviour are ' +
      'identical. Every negative outcome (wrong password, decoy, blocked user, blocked IP, ' +
      'breached, custom-DB rejection) collapses to one response: invalid_identifier_or_password. ' +
      'First handler to populate amrs (["pwd"]).',
  },

  /* ---- MFA (D3) ---------------------------------------------------------- */
  {
    id: 'action:challenge:totp:v1',
    group: 'mfa',
    label: 'Challenge — TOTP',
    status: 'spec',
    source: 'D3',
    request: [],
    emits: [],
    doc:
      'Sends nothing — the authenticator app already has the code. The challenge still exists so ' +
      'the server can record the chosen factor and commit to what it will accept next. No `index` ' +
      '(TOTP is a single logical authenticator). Note the RAPID proposes dropping no-op challenges ' +
      'like this one entirely; D3 as written keeps them.',
  },
  {
    id: 'action:challenge:phone:v1',
    group: 'mfa',
    label: 'Challenge — phone (SMS / voice)',
    status: 'spec',
    source: 'D3',
    request: [
      { name: 'index', example: 0, required: true },
      { name: 'delivery_method', example: 'text', required: false, enum: ['text', 'voice'] },
    ],
    emits: [
      { name: 'index', value: 0 },
      { name: 'identifier', value: '+1******89' },
      { name: 'delivery_method', value: ['text', 'voice'] },
    ],
    doc:
      'One enrolled phone that supports both text and voice is ONE authenticator with ' +
      'delivery_method ["text","voice"] — index enumerates distinct authenticators, not delivery ' +
      'channels. `index` is required even with a single authenticator, so the schema stays uniform.',
  },
  {
    id: 'action:challenge:push:v1',
    group: 'mfa',
    label: 'Challenge — push notification',
    status: 'spec',
    source: 'D3',
    request: [{ name: 'index', example: 0, required: true }],
    emits: [
      { name: 'index', value: 0 },
      { name: 'name', value: "Diego's iPhone" },
    ],
    doc:
      'Starts an out-of-band transaction and returns verify:oob — the only poll-based factor, ' +
      'because there is no code for the user to type.',
  },
  {
    id: 'action:challenge:recovery-code:v1',
    group: 'mfa',
    label: 'Challenge — recovery code',
    status: 'spec',
    source: 'D3',
    request: [],
    emits: [],
    doc: 'No-op send, same as TOTP. The RAPID would make this verify-only.',
  },
  {
    id: 'action:verify:oob:v1',
    group: 'mfa',
    label: 'Verify — out-of-band (push poll)',
    status: 'spec',
    source: 'D3',
    request: [],
    emits: [{ name: 'poll_in_ms', value: 2000 }],
    doc:
      'poll_in_ms rides on the descriptor, not the response root, so the client reads the interval ' +
      'off the action it is about to call and the server can retune it without a client release. ' +
      'PENDING → recoverable authorization_pending, same action again. ACCEPTED → resume. ' +
      'REJECTED → terminal authorization_rejected. Pacing is enforced server-side against the ' +
      "session's iat: polling early returns slow_down without even inspecting the transaction.",
  },
  {
    id: 'action:verify:recovery-code:v1',
    group: 'mfa',
    label: 'Verify — recovery code',
    status: 'spec',
    source: 'D3',
    request: [{ name: 'recovery_code', example: 'ABCD1234EFGH5678', required: true, secret: true }],
    emits: [],
    doc: 'Backed by mfaApi.verify.recoveryCode.',
  },

  /* ---- signup ----------------------------------------------------------- */
  {
    id: 'action:signup:v1',
    group: 'signup',
    label: 'Begin signup',
    status: 'spec',
    source: 'SIGNUP',
    request: [],
    emits: [],
    doc:
      'Switches session intent to signup. Anti-enumeration is why sign-in and signup share one ' +
      'response shape — agreed as a design constraint in the Milestone 1 plan.',
  },
  {
    id: 'action:enroll:password:v1',
    group: 'signup',
    label: 'Enroll a password',
    status: 'spec',
    source: 'SIGNUP',
    request: [{ name: 'password', example: 'Abcd@1234', required: true, secret: true }],
    emits: [
      { name: 'complexity', value: 'the connection password policy' },
      { name: 'optional', value: 'true when the step may be skipped' },
    ],
    doc: 'Sets the password during signup, after the identifier has been verified.',
  },
  {
    id: 'action:signup:confirm:v1',
    group: 'signup',
    label: 'Confirm signup',
    status: 'spec',
    source: 'SIGNUP',
    request: [],
    emits: [],
    doc: 'Final commit — creates the user and issues the authorization code.',
  },

  /* ---- interaction handoffs --------------------------------------------- */
  {
    id: 'action:interaction:form:v1',
    group: 'interaction',
    label: 'Forms interaction',
    status: 'spec',
    source: 'FORMS',
    request: [],
    emits: [
      { name: 'href', value: 'https://<tenant>/form?request_uri=urn:...:form_9tBrKx' },
      { name: 'expires_in', value: '600' },
    ],
    doc:
      'Emitted when a post-login Action calls api.prompt.render(). Two shapes depending on what ' +
      'the client declared: without action:interaction:form:native:v1 the descriptor carries an ' +
      '`href` to open in a WebView; with it, the descriptor carries form_id + journey_id for ' +
      'inline native rendering and no browser is involved.\n\n' +
      'DECIDED: the client resumes on THIS action once the journey is COMPLETED — the same id it ' +
      'was offered under, like every other paused leg. FORMS as written resumes on ' +
      'action:interaction:form:verify:v1, an action the server never offered, which would have ' +
      'forced a carve-out in the `next` allow-list. That capability is retired.\n\n' +
      'On resume the server checks getJourney(tenant, journey_id).status === COMPLETED, that ' +
      'form_id matches, and that auth_session_ref matches the inbound session — identically on ' +
      'both render paths.',
  },
  {
    id: 'action:interaction:form:native:v1',
    group: 'interaction',
    label: 'Forms — native rendering',
    status: 'spec',
    source: 'FORMS',
    request: [],
    emits: [],
    doc:
      'A client-declared capability, not a server action. Declaring it swaps the form descriptor ' +
      'from href-to-WebView over to form_id + journey_id for the native Forms SDK.\n\n' +
      'DECIDED: the binding value is carried as `journey_id`, not `state`. FORMS names it `state` ' +
      'because that is the field DX Flows stores it in, but RFC 6749 already defines `state` as ' +
      'the anti-CSRF parameter, and REDIR argues at length against reusing the word for the ' +
      'coordination reference — "Calling this reference \'state\' would conflate two distinct ' +
      'things." The same argument applies here. journey_id names what the value identifies; DX ' +
      'Flows still receives it as `state` server-side.',
  },
  {
    id: 'action:interaction:web:v1',
    group: 'interaction',
    label: 'Web interaction (Actions redirect)',
    status: 'spec',
    source: 'REDIR',
    request: [],
    emits: [
      { name: 'href', value: 'https://<tenant>/continue?request_uri=urn:...&redirect_to=...' },
      { name: 'expires_in', value: '600' },
    ],
    doc:
      'Covers an Action calling api.redirect.sendUserTo(). The app opens href; Auth0 /continue ' +
      'validates the request_uri and bounces to the customer URL; the customer page does its work ' +
      'and calls /continue?state=<request_uri> back; Auth0 advances the session and deep-links to ' +
      'the app.\n\n' +
      'The deep link carries NOTHING — REDIR states the invariant plainly: "Callbacks carry no ' +
      'tokens." The authorization code arrives only from the next POST /e/authorize, resumed on ' +
      'this same action. (This entry previously said the callback redirected "to the app with the ' +
      'code", which inverted the one guarantee the whole escape-to-web pattern rests on.)',
  },
  {
    id: 'action:interaction:captcha:verify:v1',
    group: 'interaction',
    label: 'CAPTCHA challenge',
    status: 'spec',
    source: 'BOT',
    request: [],
    emits: [
      { name: 'href', value: 'https://<tenant>/captcha?request_uri=urn:...' },
      { name: 'expires_in', value: '90' },
    ],
    doc:
      'Bot detection outcome. The request_uri record is IP/ASN-bound with a 90s TTL and holds a ' +
      'hash of the auth_session, so the server can rejoin the flow when the app resumes. Note the ' +
      'alternative Action path denies silently instead: api.access.deny("bot_detected", ' +
      '{ asCredentialFailure: true }) returns invalid_identifier_or_password, indistinguishable ' +
      'from a wrong password — deliberately no oracle.',
  },

  /* ---- federation / native social --------------------------------------- */
  {
    id: 'authn:federated:v1',
    group: 'federated',
    label: 'Federated (redirect to web)',
    status: 'spec',
    source: 'NEG',
    request: [],
    emits: [
      { name: 'href', value: 'https://<tenant>/authorize?request_uri=urn:...:fed_8xKpQrT2' },
      { name: 'expires_in', value: '300' },
    ],
    doc:
      'Declared generically by the client; the server answers with one descriptor PER eligible ' +
      'connection, specialised into the connection name — authn:federated:google-oauth2:v1, ' +
      'authn:federated:company-oidc:v1. Offered for enterprise connections, and for social ' +
      'connections only when the client has no native SDK for that strategy.\n\n' +
      'Two shapes, both in REDIR, both KEPT. Path A — one connection is eligible, so the server ' +
      'resolves it without asking and the single descriptor already carries its href; two calls ' +
      'total. Path B — several are eligible, so the descriptors come back with no href, the client ' +
      'renders the choice and echoes one action back, and the server attaches the href to that ' +
      'second response; three calls.\n\n' +
      'DECIDED: Path B\'s second response is insufficient_authorization like every other pause, NOT ' +
      'redirect_to_web, and it carries no top-level request_uri. Under the draft redirect_to_web ' +
      'means the flow does not return to /e/authorize at all — see the error vocabulary. Both ' +
      'paths resume on the same connection-specific action once the browser leg is done.',
  },
  {
    id: 'authn:ns:google:v1',
    group: 'federated',
    label: 'Native social — Google',
    status: 'spec',
    source: 'REDIR',
    request: [
      { name: 'idp_artifact', example: 'ya29.a0ARrdaM-google-access-token', required: true },
      { name: 'idp_artifact_type', example: ARTIFACT_TYPES.accessToken, required: true },
    ],
    emits: [],
    doc:
      'Offered instead of a federated redirect when the client has the native Google SDK ' +
      'configured. No href, no browser — the app authenticates against Google directly and posts ' +
      'the resulting artifact back. Google returns an ACCESS token, not an id_token.\n\n' +
      'DECIDED: `idp_artifact` plus an explicit `idp_artifact_type` URN. REDIR names the field two ' +
      'ways — its use-case matrix says idp_artifact, its worked example sends ' +
      '`"id_token": "<google_access_token>"`, a field named for an ID token carrying an access ' +
      'token. Neither reading survives all three providers, because Apple returns an authorization ' +
      'code rather than a token of any kind. The type URN removes the guesswork instead of ' +
      'encoding it in the action id.',
  },
  {
    id: 'authn:ns:apple:v1',
    group: 'federated',
    label: 'Native social — Apple',
    status: 'spec',
    source: 'REDIR',
    request: [
      { name: 'idp_artifact', example: 'c1a2b3d4e5-apple-authz-code', required: true },
      { name: 'idp_artifact_type', example: ARTIFACT_TYPES.appleAuthzCode, required: true },
    ],
    emits: [],
    doc:
      'Native SDK path — no browser handoff. Apple is the reason the field cannot be called ' +
      'id_token: it yields an AUTHORIZATION CODE, exchanged under the proprietary token-type URN ' +
      'http://auth0.com/oauth/token-type/apple-authz-code, which REDIR already documents.',
  },
  {
    id: 'authn:ns:facebook:v1',
    group: 'federated',
    label: 'Native social — Facebook',
    status: 'spec',
    source: 'REDIR',
    request: [
      { name: 'idp_artifact', example: 'EAAG-facebook-access-token', required: true },
      { name: 'idp_artifact_type', example: ARTIFACT_TYPES.accessToken, required: true },
    ],
    emits: [],
    doc: 'Native SDK path — no browser handoff. Facebook returns an access token.',
  },

  /* ---- passkey ---------------------------------------------------------- */
  {
    id: 'authn:passkey:v1',
    group: 'passkey',
    label: 'Passkey — authenticate',
    status: 'spec',
    source: 'RAPID',
    request: [],
    emits: [{ name: 'authn_params_public_key', value: '{ challenge, rpId, ... }' }],
    doc:
      'The RAPID recommends returning the passkey block EAGERLY, alongside the identify:* actions ' +
      'in the very first response, mirroring the native passkey API — that is what makes ' +
      'conditional mediation (autofill-style passkey UI) possible, the way Universal Login does it. ' +
      'Naming is unsettled: the docs carry authn:passkey:v1, action:authn:passkey:v1, and ' +
      'action:login:passkey:v1 for what looks like the same thing.',
  },
  {
    id: 'authn:passkey:register:v1',
    group: 'passkey',
    label: 'Passkey — register',
    status: 'spec',
    source: 'M1',
    request: [],
    emits: [],
    doc: 'Offered when a user does not exist yet — register a passkey instead of failing.',
  },
];

export const CAPABILITY_GROUPS = [
  { id: 'identify', label: 'Identify' },
  { id: 'challenge', label: 'Primary challenge' },
  { id: 'verify', label: 'Primary verify' },
  { id: 'mfa', label: 'MFA (Delivery 3)' },
  { id: 'signup', label: 'Signup' },
  { id: 'interaction', label: 'Interaction handoffs' },
  { id: 'federated', label: 'Federated / native social' },
  { id: 'passkey', label: 'Passkey' },
];

/**
 * Capability lookup. `authn:federated:<connection>:v1` is minted per eligible connection at
 * negotiation time and so is never in the registry — it resolves back to the generic
 * `authn:federated:v1` the client actually declared.
 */
export const byId = (id) => {
  const exact = CAPABILITIES.find((c) => c.id === id);
  if (exact) return exact;
  if (isFederatedAction(id)) return CAPABILITIES.find((c) => c.id === 'authn:federated:v1');
  return undefined;
};

/** True for a connection-specialised federation action, e.g. authn:federated:company-saml:v1. */
export const isFederatedAction = (id) =>
  typeof id === 'string' && id.startsWith('authn:federated:') && id.endsWith(':v1') && id !== 'authn:federated:v1';

/** authn:federated:company-saml:v1 → 'company-saml' */
export const connectionOfFederatedAction = (id) =>
  isFederatedAction(id) ? id.slice('authn:federated:'.length, -':v1'.length) : null;

/**
 * Connection strategies that always hand off to a browser. Transcribed from REDIR: "Enterprise
 * connections — samlp, waad, adfs, oidc, wsfed, ad, ldap, pingfederate. Always browser-redirect;
 * no native SDK path exists."
 */
export const ENTERPRISE_STRATEGIES = ['samlp', 'waad', 'adfs', 'oidc', 'wsfed', 'ad', 'ldap', 'pingfederate'];

/** Strategies authenticated by Auth0 itself — neither federated nor native-social. */
export const LOCAL_STRATEGIES = ['auth0', 'email', 'sms'];

/** Which native-social action covers which social strategy. */
export const NATIVE_SOCIAL_ACTIONS = {
  'google-oauth2': 'authn:ns:google:v1',
  apple: 'authn:ns:apple:v1',
  facebook: 'authn:ns:facebook:v1',
};

/**
 * The federated connections a preset exposes. Presets written before connection names existed
 * carry only a strategy; fall back to it so nothing silently loses its handoff.
 */
export const federatedConnections = (conn) =>
  conn?.connections?.length ? conn.connections : conn ? [{ name: conn.strategy, strategy: conn.strategy }] : [];

/** What the live tenant actually negotiates today, verified by curl. */
export const LIVE_CAPABILITIES = [
  'action:identify:email:v1',
  'action:identify:phone:v1',
  'action:challenge:email:v1',
  'action:verify:otp:v1',
];

/* ────────────────────────────────────────────────────────────────────────────
   ERROR VOCABULARY
   ──────────────────────────────────────────────────────────────────────────── */

export const ERRORS = {
  insufficient_authorization: {
    http: 403,
    kind: 'continuation',
    source: 'DRAFT',
    doc:
      'Not a failure — the normal "keep going" response, for every step the client can complete ' +
      'IN THE APP. Carries a rotated auth_session and the `next` allow-list.\n\n' +
      'The draft defines it as "the authorization server is requesting the client to take ' +
      'additional steps… continue to make requests to the authorization server until the ' +
      'authorization request is fulfilled and an authorization code returned." It MUST be HTTP ' +
      '403 — that is normative.\n\n' +
      'A step that needs a browser returns redirect_to_web instead. The one boundary case is the ' +
      'native Forms SDK: it pauses the pipeline but renders in-app, so it is this code.',
  },
  access_denied: {
    http: 403,
    kind: 'terminal',
    doc: 'The flow is over. No `next`, no auth_session — the client restarts from identify.',
  },
  invalid_request: {
    http: 400,
    kind: 'malformed',
    doc: 'Schema or negotiation failure. No reason code.',
  },
  invalid_session: {
    http: 400,
    kind: 'malformed',
    source: 'DRAFT',
    doc:
      'The draft\'s own code for this: "The provided auth_session is invalid, expired, revoked, or ' +
      'otherwise not acceptable." The tenant returns invalid_grant here instead — a code RFC 6749 ' +
      'defines for a bad authorization grant, which an auth_session is not. Free compliance win.',
  },
  invalid_grant: {
    http: 400,
    kind: 'malformed',
    doc:
      'What the tenant returns today when the auth_session is not valid; the draft defines ' +
      'invalid_session for exactly that, so this is a deviation. D3 also returns this when the ' +
      'body client_id does not match the one sealed in the session — deliberately the generic ' +
      'message, so it never confirms the session otherwise decrypted fine.',
  },
  not_implemented: {
    http: 501,
    kind: 'gap',
    doc:
      'The action negotiated, was advertised in `next`, and then had no handler behind it. A ' +
      'client that trusts `next` — which is the contract — cannot avoid this, so it is a gap in ' +
      'the server rather than a mistake by the caller. Reached today by identify:phone.',
  },
  server_error: {
    http: 500,
    kind: 'bug',
    doc: 'Unexpected. Observed live when submitting an action that is not in the current `next`.',
  },
  redirect_to_web: {
    http: 403,
    kind: 'handoff',
    source: 'DRAFT',
    doc:
      'Every pause that sends the user to a browser: CAPTCHA, federation, a hosted form, an ' +
      'Actions redirect. Carries the coordination reference as a top-level `request_uri`, in the ' +
      'draft\'s own shape.\n\n' +
      'The draft names these cases in its usage text — "The authorization server may choose to ' +
      'interact directly with the user based on a risk assessment, the introduction of a new ' +
      'authentication method not supported in the application, or to handle an exception flow such ' +
      'as account recovery." Risk assessment is bot detection; an auth method the app cannot do ' +
      'natively is federation.\n\n' +
      'Two things to know. First, the draft is SILENT on what happens after the browser leg — it ' +
      'never says the client cannot come back to /e/authorize, which is what our escape-to-web ' +
      'pattern does. Its own definition ("not able to be fulfilled with any further direct ' +
      'interaction with the user") reads against that, so this is a decision, not a citation. ' +
      'See DECISIONS.\n\n' +
      'Second, the draft is strict about the parameter: "If the client does not include a PKCE ' +
      'code_challenge in the initial authorization challenge request, the authorization server ' +
      'MUST NOT return a request_uri in the redirect_to_web error response." So the reference is ' +
      'withheld — not the whole response — when initiate carried no code_challenge.',
  },
};

export const ERROR_DESCRIPTIONS = [
  {
    code: 'invalid_identifier_or_code',
    recoverable: true,
    status: 'live',
    source: 'D2',
    doc:
      'Deliberately ambiguous, and deliberately covers BOTH "wrong code" and "no such user" — ' +
      'collapsing them is precisely what lets the decoy and wrong-code responses be byte-identical. ' +
      'The vagueness is the feature.',
  },
  {
    code: 'invalid_identifier_or_password',
    recoverable: true,
    status: 'spec',
    source: 'PWD',
    doc:
      'Same ambiguity for the password path, and it also absorbs blocked-user, blocked-IP, and ' +
      'breached-password outcomes — a deliberate loss of fidelity, since those are true statements ' +
      'about an account that exists.',
  },
  { code: 'invalid_code', recoverable: true, status: 'spec', source: 'D3',
    doc: 'A failed verify once the subject is already established, so ambiguity is no longer needed.' },
  { code: 'authorization_pending', recoverable: true, status: 'spec', source: 'D3',
    doc: 'Push not yet approved. Poll the same action again after poll_in_ms.' },
  { code: 'slow_down', recoverable: true, status: 'spec', source: 'D3',
    doc: 'Polled before poll_in_ms elapsed. The server does not even look at the transaction.' },
  { code: 'consent_required', recoverable: false, status: 'live', source: 'D2',
    doc: 'A satisfied login resumed into a consent step a JSON-only flow cannot service. Fall back to a redirect flow.' },
  { code: 'too_many_wrong_otp_attempts', recoverable: false, status: 'live', source: 'D2',
    doc: 'The 5-attempt cap. Real users are capped by auth0-users\' own limiter; decoys by a counter that mimics it at exactly 5, so lockout timing cannot leak existence either.' },
  { code: 'authorization_rejected', recoverable: false, status: 'spec', source: 'D3',
    doc: 'Push explicitly denied — a decision, not something to retry.' },
  { code: 'challenge_expired', recoverable: false, status: 'spec', source: 'D3',
    doc: 'The out-of-band transaction expired or was not found.' },
  { code: 'no_eligible_factors', recoverable: false, status: 'spec', source: 'D3',
    doc: 'Policy requires a second factor but the user has none enrolled, and D3 adds no in-flow enrollment. Terminal by design.' },
];

/* ────────────────────────────────────────────────────────────────────────────
   CONNECTION PRESETS — drive negotiation in spec mode
   ──────────────────────────────────────────────────────────────────────────── */

export const CONNECTION_PRESETS = [
  {
    id: 'db-email-otp',
    label: 'Database — email OTP only',
    strategy: 'auth0',
    identifiers: ['email'],
    authMethods: ['email_otp'],
    note: 'What the verified tenant looks like. The only shape that completes a login today.',
  },
  {
    id: 'db-password',
    label: 'Database — password only',
    strategy: 'auth0',
    identifiers: ['email', 'username'],
    authMethods: ['password'],
    note:
      'What nearly every existing tenant looks like — and embedded cannot sign in against it yet. ' +
      'Negotiation yields an empty intersection, so initiate fails with invalid_request.',
  },
  {
    id: 'db-both',
    label: 'Database — password + email OTP',
    strategy: 'auth0',
    identifiers: ['email', 'username'],
    authMethods: ['password', 'email_otp'],
    note:
      'Shows method switching: with an email identifier, `next` carries verify:password AND ' +
      'challenge:email at once, and keeps re-offering both after a failure. Switching needs no ' +
      'server command — it falls out of computing `next` correctly.',
  },
  {
    id: 'db-full',
    label: 'Database — password, OTP, passkey, phone',
    strategy: 'auth0',
    identifiers: ['email', 'username', 'phone'],
    authMethods: ['password', 'email_otp', 'phone_otp', 'passkey'],
    note: 'Everything a database connection can enable.',
  },
  {
    id: 'social-google',
    label: 'Social — Google',
    strategy: 'google-oauth2',
    identifiers: [],
    authMethods: [],
    connections: [{ name: 'google-oauth2', strategy: 'google-oauth2' }],
    note:
      'Federated. Offers a redirect handoff, unless the client declares a native Google SDK — ' +
      'then it offers authn:ns:google:v1 instead and no browser opens. One eligible connection, ' +
      'so the handoff resolves in a single round-trip (Path A).',
  },
  {
    id: 'enterprise-saml',
    label: 'Enterprise — SAML',
    strategy: 'samlp',
    identifiers: [],
    authMethods: [],
    connections: [{ name: 'company-saml', strategy: 'samlp' }],
    note:
      'Always a redirect handoff — there is no native path for enterprise connections. Note the ' +
      'connection is named company-saml while its strategy is samlp: the action specialises on the ' +
      'NAME, so this negotiates authn:federated:company-saml:v1.',
  },
  {
    id: 'social-multi',
    label: 'Social — Google + GitHub',
    strategy: 'google-oauth2',
    identifiers: [],
    authMethods: [],
    connections: [
      { name: 'google-oauth2', strategy: 'google-oauth2' },
      { name: 'github', strategy: 'github' },
    ],
    note:
      'Two eligible federated connections, so nothing resolves them down to one — the Path B ' +
      'shape. `next` carries both actions with no href; the client renders the choice and echoes ' +
      'one back, and only then does the server mint a request_uri.',
  },
  {
    id: 'enterprise-multi-oidc',
    label: 'Enterprise — two OIDC connections',
    strategy: 'oidc',
    identifiers: [],
    authMethods: [],
    connections: [
      { name: 'acme-oidc', strategy: 'oidc' },
      { name: 'globex-oidc', strategy: 'oidc' },
    ],
    note:
      'The case REDIR calls out by name to justify specialising on connection rather than ' +
      'strategy: two connections, one strategy. Keyed on strategy both would collapse into a ' +
      'single authn:federated:oidc:v1 and the second IdP would be unreachable.',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   KNOWN GAPS — spec says X, tenant does Y
   ──────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────
   DECISIONS — settled contradictions, and why

   Each of these was a place two documents (or one document and itself) described the same event
   two ways. They are recorded rather than silently applied, because someone reading the source
   RFDs will find the other answer there and needs to know it was considered.

   `basis: 'draft'` means the IETF draft settled it and there was nothing to choose. `basis:
   'ours'` means the draft is silent and this is an Auth0 decision.
   ──────────────────────────────────────────────────────────────────────────── */

export const DECISIONS = [
  {
    title: 'A paused leg resumes on the action it was offered under',
    basis: 'ours',
    conflict:
      'CAPTCHA and the Actions redirect are offered and resumed on one action id. FORMS offers ' +
      'action:interaction:form:v1 and resumes on action:interaction:form:verify:v1 — an action ' +
      'the server never advertised.',
    decision:
      'Send back exactly what was offered, for every leg. action:interaction:form:verify:v1 is ' +
      'retired.',
    why:
      'D2 #3 makes `next` the server-side allow-list, and that is what stops a client skipping a ' +
      'step. Admitting one unadvertised action turns the allow-list into a guideline, and the ' +
      'exception has to be carried by every server and SDK forever. One rule describes the whole ' +
      'protocol instead.',
    source: 'FORMS',
  },
  {
    title: 'Native social posts idp_artifact plus an explicit type URN',
    basis: 'ours',
    conflict:
      'REDIR\'s use-case matrix says the resume call carries `idp_artifact`; its worked example on ' +
      'the same page sends `id_token` holding a Google ACCESS token, and the prose hedges — ' +
      '"might be id_token or another artifact".',
    decision:
      'idp_artifact + idp_artifact_type. Access tokens use RFC 8693\'s registered URN ' +
      '(urn:ietf:params:oauth:token-type:access_token); Apple keeps the proprietary ' +
      'http://auth0.com/oauth/token-type/apple-authz-code that REDIR already documents.',
    why:
      'The providers do not return the same kind of thing, so no single field name is honest ' +
      'without a type: Apple returns an authorization code, not a token. Inferring the kind from ' +
      'the action id works only until one provider returns two kinds. RFC 8693 already registered ' +
      'a URN for an access token, so there is no reason to mint a parallel Auth0 one.',
    source: 'REDIR',
  },
  {
    title: 'The native form binding is journey_id, not state',
    basis: 'ours',
    conflict:
      'FORMS names it `state` because that is the field DX Flows stores it in. RFC 6749 already ' +
      'defines `state` as the anti-CSRF parameter, and the Actions redirect separately passes ' +
      'state=<request_uri> to the customer endpoint — three objects, one word.',
    decision: 'The descriptor carries `journey_id`. DX Flows still receives it as `state` server-side.',
    why:
      'REDIR makes this exact argument when justifying request_uri over state: "Calling this ' +
      'reference \'state\' would conflate two distinct things." Applying its own reasoning one ' +
      'page over. journey_id names what the value identifies rather than the field it lands in.',
    source: 'FORMS',
  },
  {
    title: 'Path A stays — an href can ride on the first response',
    basis: 'ours',
    conflict:
      'REDIR describes both a one-round-trip path when HRD resolves the connection and a ' +
      'two-round-trip path when it does not.',
    decision:
      'Keep both. One eligible connection → the descriptor carries its href immediately. Several → ' +
      'no href until the client echoes its choice.',
    why:
      'The draft models the challenge endpoint as a loop of requests and does not care how many ' +
      'iterations it takes, so nothing forbids it. Enterprise SSO is the common case and it saves ' +
      'a round-trip there. Clients already branch on whether a descriptor carries an href, because ' +
      'native social and the native form path carry none.',
    source: 'REDIR',
  },
  {
    title: 'A pause that opens a browser is redirect_to_web with a request_uri',
    basis: 'ours',
    conflict:
      'REDIR uses error: redirect_to_web with a top-level request_uri on Path B\'s second call, but ' +
      'insufficient_authorization on Path A and on the forms and Actions-redirect legs. BOT\'s prose ' +
      'calls redirect_to_web "the spec-aligned path" while every one of its worked examples uses ' +
      'insufficient_authorization. So the same architectural event appears under both codes, ' +
      'sometimes within one page.',
    decision:
      'redirect_to_web, with the coordination reference as a top-level request_uri, on every pause ' +
      'that sends the user to a browser — CAPTCHA, federation (both paths), the hosted form, the ' +
      'Actions redirect. Steps the client completes in-app stay insufficient_authorization, ' +
      'including the native Forms SDK path, which pauses the pipeline but opens no browser.',
    why:
      'The draft\'s usage text names these cases: "The authorization server may choose to interact ' +
      'directly with the user based on a risk assessment, the introduction of a new authentication ' +
      'method not supported in the application, or to handle an exception flow such as account ' +
      'recovery." Risk assessment is bot detection; an auth method the app cannot do natively is ' +
      'federation. A distinct code also states the one thing the client must do differently — leave ' +
      'the app — instead of making it infer that from the presence of an `href`.\n\n' +
      'Two costs, accepted knowingly. (1) The draft\'s definition says redirect_to_web means the ' +
      'request "is not able to be fulfilled with any further direct interaction with the user", ' +
      'and our legs DO come back to /e/authorize. The draft never says the client cannot return — ' +
      'it is silent on what follows the browser leg — so this stretches the definition rather than ' +
      'contradicting a rule. (2) A draft-only client would consume request_uri per RFC 9126 §4, ' +
      'navigating to /authorize?request_uri=…; our CAPTCHA and form references live at /captcha ' +
      'and /form, so for those the real instruction is the `href`, and the top-level request_uri ' +
      'is informational. Folding every leg behind /authorize?request_uri= would fix that and is ' +
      'the obvious follow-up if a spec-compliant SDK ever needs to work without knowing `next[]`.',
    source: 'REDIR',
  },
  {
    title: 'The challenge stays in `next` while its code is outstanding',
    basis: 'ours',
    conflict:
      'The Password RFD contradicts itself on the same page. Its Non-Goals defer "OTP resend / ' +
      're-challenge" outright, while its Design decision 8 says verify:password and challenge:email ' +
      'are both in `next` "at the method step, and again after a failed password attempt, and after ' +
      'a failed OTP attempt". The signup model settles it in one direction: all 36 responses that ' +
      'offer verify:otp re-offer the challenge beside it — including on OTP-only connections, which ' +
      'Decision 8 never covers because its table is about choosing between methods.',
    decision:
      'The challenge action stays in `next` whenever an OTP for that channel is outstanding, on ' +
      'every connection. The Non-Goals bullet is read narrowly: no dedicated resend ACTION, and no ' +
      'resend-specific rate limiting — not the withdrawal of the challenge from `next`.',
    why:
      'The two readings only diverge on a single-method connection, and that is exactly where a ' +
      'resend matters most: with no other method to switch to, a user whose code never arrived ' +
      'would have no way forward but restarting the flow. Following the narrow reading also needs ' +
      'no special case — the challenge is simply still eligible — whereas withdrawing it means ' +
      'writing a rule whose only effect is to strand that user.\n\n' +
      'Two consequences carried deliberately. A resend issues a fresh ticket and does NOT reset ' +
      'the wrong-code counter, or the attempt cap could be dodged by asking for a new code between ' +
      'guesses. And nothing rate-limits it: D2 defers anti-bombing entirely, so the OTP-bombing ' +
      'vector is now reachable on purpose rather than only by replaying a session.',
    source: 'PWD',
  },
  {
    title: 'No PKCE at initiate means no request_uri',
    basis: 'draft',
    conflict:
      'No example in any of the three documents sends a code_challenge on the initiate call, yet ' +
      'REDIR returns a request_uri.',
    decision:
      'The initiate request carries code_challenge + code_challenge_method. Without them the ' +
      'handoff still returns redirect_to_web and an href, but the top-level request_uri is ' +
      'withheld.',
    why:
      'Normative: "If the client does not include a PKCE code_challenge in the initial ' +
      'authorization challenge request, the authorization server MUST NOT return a request_uri in ' +
      'the redirect_to_web error response, as that would effectively be the same as a PAR request ' +
      'without PKCE." Withholding the parameter rather than refusing the request follows the ' +
      'draft\'s own fallback — a client with no request_uri starts its own authorization code flow ' +
      'with PKCE.',
    source: 'DRAFT',
  },
];

export const KNOWN_GAPS = [
  {
    title: 'error_description carries machine codes, not developer prose',
    severity: 'spec-deviation',
    spec:
      'The draft: "Response parameters error, error_description, and error_uri are defined and ' +
      'used according to [RFC6749]." RFC 6749 §5.2 defines error_description as "human-readable ' +
      'ASCII text providing additional information, used to assist the CLIENT DEVELOPER in ' +
      'understanding the error" — prose to read, not a value to branch on. For machine-readable ' +
      'reasons the draft points at the other field: "This specification requires the authorization ' +
      'server to define new ERROR CODES that relate to the actions the client must take."',
    actual:
      'error_description is a closed enum of reason codes — invalid_identifier_or_code, ' +
      'invalid_identifier_or_password, and the D3 additions slow_down, authorization_pending and ' +
      'invalid_code. The Password RFD pins it in the schema, which is precisely what invites a ' +
      'client to switch on it.',
    impact:
      'Every SDK will branch on error_description, so it is load-bearing whatever RFC 6749 calls ' +
      'it, and the enum can never be widened without breaking those clients. The spec-aligned ' +
      'shape would put the reason in `error` and leave error_description as text. Kept as the ' +
      'documents define it — three RFDs and any SDK already written against them agree on the ' +
      'current shape — and recorded here so it reads as a decision rather than an oversight.',
    source: 'DRAFT',
  },
  {
    title: 'auth_session is not bound to a device',
    severity: 'security',
    spec:
      'The draft: "To mitigate the risk of session hijacking, the auth_session SHOULD be bound to ' +
      'the device, and the authorization server SHOULD reject an auth_session if it is presented ' +
      'from a different device than the one it was bound to" — suggesting the DPoP public key as ' +
      'the binding, and requiring at least 256 bits of entropy on the value.',
    actual:
      'No device binding at any point. The only binding anywhere in the design is BOT\'s IP/ASN ' +
      'stamp, which is applied ONLY after a CAPTCHA is solved and only when bot detection is on.',
    impact:
      'A lifted auth_session works from anywhere, which is what makes the existing replay gap ' +
      'worth more to an attacker. BOT\'s post-CAPTCHA stamp is a narrow, ad-hoc version of a ' +
      'control the draft wants applied to every session — worth generalising rather than leaving ' +
      'as a bot-detection side effect.',
    source: 'DRAFT',
  },
  {
    title: 'Web-leg lifetimes are never told to the client',
    severity: 'gap',
    spec:
      'The draft defines expires_in as an OPTIONAL response parameter giving the lifetime of the ' +
      'reference in seconds.',
    actual:
      'The TTLs exist and differ per case — 90s CAPTCHA, 300s federation, 600s forms and Actions ' +
      'redirects — but live only in Redis. Nothing reaches the client.',
    impact:
      'An app cannot tell an expired href from a broken one, cannot warn a user before a CAPTCHA ' +
      'lapses, and cannot pre-emptively refresh. The recovery path works, but only by failing ' +
      'first. The simulator emits expires_in on every web-leg descriptor.',
    source: 'DRAFT',
  },
  {
    title: 'No CORS on POST /e/authorize',
    severity: 'blocking-for-spa',
    spec:
      'D3 specifies CORS for POST /e/authorize with an OPTIONS preflight, reusing the allow_origins ' +
      'components EMBL-1317 already shipped for GET /e/discovery.',
    actual:
      'OPTIONS /e/authorize → 404. POST returns no access-control-allow-origin. GET /e/discovery ' +
      'was recorded as sending access-control-allow-origin: * — see the caveat below.',
    impact:
      'No browser-based SDK can call /e/authorize cross-origin today. It is why this playground ' +
      'proxies live calls through /api/e-proxy. Planned, not yet shipped.\n\n' +
      'UNVERIFIED, and worth re-testing before anyone relies on it. The wildcard was recorded ' +
      'against GET /e/discovery, but the Discovery RFD decision 11 says the GET uses ' +
      'allowlist-gated REFLECTION — it echoes the caller\'s Origin on a match and sends no ' +
      'access-control-allow-origin at all on a miss. A literal * appears in exactly one place ' +
      'there, and it is the other method: "the preflight answers Access-Control-Allow-Origin: * ' +
      'regardless of the allowlist, because the allowlist is enforced on the GET response".\n\n' +
      'So either the tenant deviates from the RFD, or the curl measured OPTIONS rather than GET. ' +
      'To tell them apart: reflection echoes the request Origin — never a literal * — and pairs ' +
      'with Vary: Origin. If the GET really does answer *, that is a security finding rather than ' +
      'a note: the per-client allowlist would not be applied to the response the browser gates ' +
      'reading on, leaving an unauthenticated configuration-disclosure endpoint readable by any ' +
      'origin, which is what the per-client embedded_discovery setting exists to control.',
    source: 'D3',
  },
  {
    title: 'auth_session replay is not rejected',
    severity: 'security',
    spec:
      'D2 decision #4: each accepted request consumes its jti and the response carries a fresh ' +
      'auth_session; replaying a consumed auth_session is rejected. Single-use was explicitly ' +
      'deferred from EMBL-1078 into D2.',
    actual:
      'The same auth_session can be reused indefinitely. Verified by replaying identify with three ' +
      'different emails on one session, all accepted, and by replaying challenge:email three times ' +
      '— each one re-sends the OTP.',
    impact:
      'Step replay is possible, and replayable challenge:email is an OTP-bombing vector. D2 also ' +
      'deferred anti-bombing rate limits and has no resend, so replay is currently the de-facto ' +
      'resend with none of the protections a real resend would carry.\n\n' +
      'Spec mode implements the end state: every response burns the session it was presented with, ' +
      'and replaying a consumed value returns invalid_session — the draft\'s code for it, where ' +
      'the tenant answers invalid_grant. Drive the "Replayed auth_session" scenario to see both.',
    source: 'D2',
  },
  {
    title: 'Out-of-order action returns 500, not invalid_request',
    severity: 'resolved',
    resolvedOn: '2026-09-03',
    spec:
      'D2 decision #3: `next` is both the response and the server-side allow-list the inbound ' +
      'action is validated against, so a client cannot skip challenge and jump to verify.',
    actual:
      'RESOLVED, re-verified 2026-09-03. The tenant now answers 400 invalid_request with ' +
      '"The action is not permitted in the current state." It previously returned 500 server_error ' +
      '"An unexpected error occurred", which is what this entry recorded on 2026-09-01. Kept rather ' +
      'than deleted so a 500 reappearing reads as a regression against something that once worked, ' +
      'not as a fresh discovery.\n\n' +
      'One difference remains, and it is spec mode that is ahead: the tenant sends no auth_session ' +
      'or next on that 400, so the console dead-ends, while spec mode restates both because nothing ' +
      'was consumed.',
    impact:
      'While it lasted, an SDK could not tell "you called the wrong action" from "the service is ' +
      'broken". Spec mode never reproduced it, and now the tenant agrees.',
    source: 'D2',
  },
  {
    title: 'GET /e/discovery has three distinct refusals',
    severity: 'config',
    spec:
      'Three different failures a caller can receive, each with its own status and code:\n' +
      '  404                      — discovery is not available for this tenant\n' +
      '  400 invalid_request      — not enabled for this client_id, or malformed input\n' +
      '  401 invalid_client       — the client_id does not resolve for this tenant\n' +
      'And one non-failure worth stating: no matching grants is 200 { "alternatives": [] }, not an ' +
      'error. The 400 covers two cases — not-enabled and malformed — separated only by ' +
      'error_description, which is discovery\'s own closed vocabulary and shares nothing with the ' +
      '/e/authorize enum.',
    actual:
      '400 invalid_request — "Embedded discovery is not enabled for this client." That is the ' +
      'not-enabled case; the 404 and 401 have not been exercised here.',
    impact:
      'A client has to tell these apart to behave sensibly. The 404 is the one most likely to be ' +
      'misread — an SDK that treats it as "wrong URL" will report a bug in itself rather than a ' +
      'tenant that has not been enabled. And an empty alternatives array must not be handled as a ' +
      'failure: it is the truthful answer for a client with no matching grants.',
    source: 'DISCO',
  },
  {
    title: 'identify:phone negotiates but has no handler',
    severity: 'gap',
    spec: 'The capability is in the registry and negotiates.',
    actual: 'Appears in `next`, but invoking it resolves to 501 not_implemented.',
    impact:
      'A connection whose only active identifier is phone_number cannot log in at all — and password ' +
      'login stays unreachable there even after the Password RFD ships. Called out in its non-goals.',
    source: 'PWD',
  },
  {
    title: 'Capability naming is inconsistent across specs',
    severity: 'spec-hygiene',
    spec: 'Ids follow action:{CATEGORY}:{TYPE}:{VERSION}.',
    actual:
      'Passkey appears as authn:passkey:v1, action:authn:passkey:v1, and action:login:passkey:v1. ' +
      'Primary factors appear as both authn:password:v1 and action:verify:password:v1, and both ' +
      'authn:otp:email:v1 and action:challenge:email:v1, across different documents.',
    impact:
      'SDK authors reading two RFDs get two vocabularies. The RAPID is the live attempt to settle ' +
      'the challenge/verify half of this.',
    source: 'RAPID',
  },
];

/* Masking, matching what the tenant actually returned: haze******@okta**** */
export function maskIdentifier(value) {
  if (!value) return '';
  const at = value.indexOf('@');
  if (at === -1) {
    return value.slice(0, 2) + '*'.repeat(Math.max(1, value.length - 2));
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  const domainHead = dot === -1 ? domain : domain.slice(0, dot);
  const domainTail = dot === -1 ? '' : domain.slice(dot);
  const keepLocal = Math.min(4, local.length);
  const keepDomain = Math.min(4, domainHead.length);
  return (
    local.slice(0, keepLocal) +
    '*'.repeat(Math.max(1, local.length - keepLocal)) +
    '@' +
    domainHead.slice(0, keepDomain) +
    // The TLD is masked too, but contributes no extra star beyond its own length —
    // hazel.nutt@okta.com → haze******@okta**** (4 stars for ".com", not 5).
    '*'.repeat(Math.max(0, domainHead.length - keepDomain) + domainTail.length)
  );
}
