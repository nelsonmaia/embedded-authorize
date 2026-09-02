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
};

export const confluenceUrl = (id) =>
  `https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/${id}`;

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
    emits: [],
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
    emits: [],
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
      { name: 'channel', value: 'email' },
      { name: 'identifier', value: '<masked>' },
    ],
    doc:
      'Sends the code for a real user. For a decoy it sends nothing and pads the response time ' +
      '(OTP_CHALLENGE_MIN_RESPONSE_TIME_MS) so latency does not leak existence. Both paths return ' +
      'an identical descriptor, including a masked identifier — the decoy gets a mask of the ' +
      'address it submitted. Reused unchanged as an MFA challenge in D3.',
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
    emits: [],
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
    emits: [{ name: 'href', value: 'https://<tenant>/form?request_uri=urn:...:form_9tBrKx' }],
    doc:
      'Emitted when a post-login Action calls api.prompt.render(). Two shapes depending on what ' +
      'the client declared: without action:interaction:form:native:v1 the descriptor carries an ' +
      '`href` to open in a WebView; with it, the descriptor carries form_id + state for inline ' +
      'native rendering and no browser is involved.',
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
      'from href-to-WebView over to form_id + state for the native Forms SDK.',
  },
  {
    id: 'action:interaction:form:verify:v1',
    group: 'interaction',
    label: 'Forms — signal completion',
    status: 'spec',
    source: 'FORMS',
    request: [],
    emits: [],
    doc:
      'The client calls this once the form journey is COMPLETED. The server verifies the journey ' +
      'against DX Flows, advances the Actions pipeline, and issues the code.',
  },
  {
    id: 'action:interaction:web:v1',
    group: 'interaction',
    label: 'Web interaction (Actions redirect)',
    status: 'spec',
    source: 'REDIR',
    request: [],
    emits: [{ name: 'href', value: 'https://custom.example.com/verify-age?state=...' }],
    doc:
      'Covers an Action calling api.redirect.sendUserTo(). The app opens href, the custom page ' +
      'does its work and calls /continue?state=..., and Auth0 resumes the pipeline and redirects ' +
      'to the app with the code.',
  },
  {
    id: 'action:interaction:captcha:verify:v1',
    group: 'interaction',
    label: 'CAPTCHA challenge',
    status: 'spec',
    source: 'BOT',
    request: [],
    emits: [{ name: 'href', value: 'https://<tenant>/captcha?request_uri=urn:...' }],
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
    emits: [],
    doc:
      'Declared generically by the client; the server answers with one descriptor PER eligible ' +
      'connection, specialised into the connection name — authn:federated:google-oauth2:v1, ' +
      'authn:federated:company-oidc:v1. Offered for enterprise connections, and for social ' +
      'connections only when the client has no native SDK for that strategy.',
  },
  {
    id: 'authn:oauth2:v1',
    group: 'federated',
    label: 'OAuth2 handoff',
    status: 'spec',
    source: 'REDIR',
    request: [{ name: 'connection', example: 'google-oauth2', required: true }],
    emits: [{ name: 'connection', value: 'google-oauth2' }],
    doc:
      'Selecting it returns error: redirect_to_web + a request_uri. The server has PAR-pushed the ' +
      'connection, redirect_uri, and code_challenge from step 1 — redirect_uri is NOT repeated, it ' +
      'was registered in the session at initiate. The whole IdP round-trip happens in the browser ' +
      '(ASWebAuthenticationSession / Custom Tabs), opaque to the app, and comes back as a code.',
  },
  {
    id: 'authn:ns:google:v1',
    group: 'federated',
    label: 'Native social — Google',
    status: 'spec',
    source: 'NEG',
    request: [],
    emits: [],
    doc: 'Offered instead of a federated redirect when the client has the native Google SDK configured.',
  },
  {
    id: 'authn:ns:apple:v1',
    group: 'federated',
    label: 'Native social — Apple',
    status: 'spec',
    source: 'NEG',
    request: [],
    emits: [],
    doc: 'Native SDK path — no browser handoff.',
  },
  {
    id: 'authn:ns:facebook:v1',
    group: 'federated',
    label: 'Native social — Facebook',
    status: 'spec',
    source: 'NEG',
    request: [],
    emits: [],
    doc: 'Native SDK path — no browser handoff.',
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

export const byId = (id) => CAPABILITIES.find((c) => c.id === id);

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
    doc:
      'Not a failure — the normal "keep going" response. Carries a rotated auth_session and the ' +
      '`next` allow-list. Every hop before the final one looks like this.',
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
  invalid_grant: {
    http: 400,
    kind: 'malformed',
    doc:
      'The auth_session is not valid. D3 also returns this when the body client_id does not match ' +
      'the one sealed in the session — deliberately the generic message, so it never confirms the ' +
      'session otherwise decrypted fine.',
  },
  server_error: {
    http: 500,
    kind: 'bug',
    doc: 'Unexpected. Observed live when submitting an action that is not in the current `next`.',
  },
  redirect_to_web: { http: 403, kind: 'handoff', doc: 'Continue in a browser; carries a request_uri.' },
  interaction_required: { http: 403, kind: 'handoff', doc: 'Actions redirect; carries an href.' },
  form_interaction_required: {
    http: 403,
    kind: 'handoff',
    doc: 'A form must be completed; carries form_token + forms_requirements.',
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
    note:
      'Federated. Offers a redirect handoff, unless the client declares a native Google SDK — ' +
      'then it offers authn:ns:google:v1 instead and no browser opens.',
  },
  {
    id: 'enterprise-saml',
    label: 'Enterprise — SAML',
    strategy: 'samlp',
    identifiers: [],
    authMethods: [],
    note: 'Always a redirect handoff — there is no native path for enterprise connections.',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   KNOWN GAPS — spec says X, tenant does Y
   ──────────────────────────────────────────────────────────────────────────── */

export const KNOWN_GAPS = [
  {
    title: 'No CORS on POST /e/authorize',
    severity: 'blocking-for-spa',
    spec:
      'D3 specifies CORS for POST /e/authorize with an OPTIONS preflight, reusing the allow_origins ' +
      'components EMBL-1317 already shipped for GET /e/discovery.',
    actual:
      'OPTIONS /e/authorize → 404. POST returns no access-control-allow-origin. GET /e/discovery ' +
      'does send access-control-allow-origin: *.',
    impact:
      'No browser-based SDK can call /e/authorize cross-origin today. It is why this playground ' +
      'proxies live calls through /api/e-proxy. Planned, not yet shipped.',
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
      'resend with none of the protections a real resend would carry.',
    source: 'D2',
  },
  {
    title: 'Out-of-order action returns 500, not invalid_request',
    severity: 'bug',
    spec:
      'D2 decision #3: `next` is both the response and the server-side allow-list the inbound ' +
      'action is validated against, so a client cannot skip challenge and jump to verify.',
    actual:
      'Correctly refused — but with 500 server_error "An unexpected error occurred", not a 4xx. ' +
      'Verified by calling verify:otp directly on a fresh session.',
    impact:
      'The allow-list holds, so this is not a security gap. But an SDK cannot tell "you called the ' +
      'wrong action" from "the service is broken", and it pollutes error budgets.',
    source: 'D2',
  },
  {
    title: 'GET /e/discovery is gated per client',
    severity: 'config',
    spec: 'Access is governed by an embedded_discovery feature flag plus a per-client embedded_discovery setting.',
    actual: '400 invalid_request — "Embedded discovery is not enabled for this client."',
    impact: 'Expected behaviour, not a defect — but it means discovery cannot be demoed until the client setting is on.',
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
