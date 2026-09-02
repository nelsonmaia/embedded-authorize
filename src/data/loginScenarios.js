/**
 * flows.js — named scenarios.
 *
 * Each scenario is a starting configuration plus an optional `script` of steps that can be
 * auto-played. A scenario is not a recording: it configures the engine and then drives the
 * real state machine, so the responses you see are produced by the same negotiation logic as
 * clicking through by hand.
 */

export const SCENARIOS = [
  {
    id: 'otp-happy',
    label: 'Email OTP — happy path',
    badge: 'live',
    categories: ['login'],
    expect: 'code',
    summary:
      'Identify, challenge, verify, code. The shortest complete login, and the one path already ' +
      'verified end to end against a real tenant.',
    connection: 'db-email-otp',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:challenge:email:v1' },
      { action: 'action:verify:otp:v1', payload: { otp: '123456' } },
    ],
  },
  {
    id: 'otp-decoy',
    label: 'Anti-enumeration — decoy user',
    badge: 'live',
    categories: ['login'],
    expect: 'continues',
    demonstrates: 'invalid_identifier_or_code',
    summary:
      'The same flow with an address that does not exist. Compare every response against the ' +
      'happy path — you should not be able to tell them apart.',
    connection: 'db-email-otp',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'nobody-xyz-9931@example.com' } },
      { action: 'action:challenge:email:v1' },
      { action: 'action:verify:otp:v1', payload: { otp: '123456' } },
    ],
  },
  {
    id: 'otp-lockout',
    label: 'Wrong code → lockout',
    badge: 'live',
    categories: ['login', 'errors'],
    expect: 'denied',
    summary:
      'The rule: 5 wrong codes and the session is gone. The first 4 are recoverable — the same ' +
      '`next` comes back, so you can retry or ask for a fresh code — and the 5th is terminal: ' +
      'access_denied, no `next`, no auth_session, start over. Resending does not reset the count.',
    connection: 'db-email-otp',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:challenge:email:v1' },
      { action: 'action:verify:otp:v1', payload: { otp: '000000' } },
      { action: 'action:verify:otp:v1', payload: { otp: '000001' } },
      { action: 'action:verify:otp:v1', payload: { otp: '000002' } },
      { action: 'action:verify:otp:v1', payload: { otp: '000003' } },
      { action: 'action:verify:otp:v1', payload: { otp: '000004' } },
    ],
  },
  {
    id: 'session-replay',
    label: 'Replayed auth_session is refused',
    badge: 'spec',
    categories: ['errors'],
    expect: 'invalid_session',
    summary:
      'Send back the session from two responses ago. Each accepted request burns the session it ' +
      'was presented with, so a replayed value is refused with invalid_session — the code the IETF ' +
      'draft defines for exactly this.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:verify:password:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      // spec-session-1 was burned by the identify call above.
      { action: 'action:verify:password:v1', payload: { auth_session: 'spec-session-1', password: 'Abcd@1234' } },
      // Nothing follows: unlike a wrong password, a refused session carries no `next` to continue
      // from, so the client has to restart. That is the whole point of rejecting it.
    ],
  },
  {
    id: 'out-of-order',
    label: 'Skipping a step is refused',
    badge: 'live',
    categories: ['errors'],
    expect: 'refused',
    summary:
      'Call verify without a challenge. `next` is not a hint — it is the server-side allow-list ' +
      'the inbound action is validated against, so the call is refused with invalid_request and ' +
      'the session is left untouched.',
    connection: 'db-email-otp',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:verify:otp:v1', payload: { otp: '123456' } },
    ],
  },
  {
    id: 'attack-protection-mask',
    label: 'Blocked account looks like a typo',
    badge: 'spec',
    categories: ['login', 'errors'],
    expect: 'continues',
    demonstrates: 'invalid_identifier_or_password',
    summary:
      'The password below is CORRECT, but the account is blocked. The response is byte-identical ' +
      'to a wrong password \u2014 blocked account, blocked IP, breached credential and a typo all ' +
      'collapse into one answer, because "your account is blocked" confirms the account exists. ' +
      'Whether that masking should hold for the outcomes that are NOT account-specific is an open ' +
      'question on the Password RFD.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:verify:password:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234', simulate: 'user_blocked' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234', simulate: 'ip_blocked' } },
    ],
  },
  {
    id: 'missing-field',
    label: 'A required field is missing',
    badge: 'spec',
    categories: ['errors'],
    expect: 'refused',
    summary:
      'Send identify with no email. 400 invalid_request, and note the error_description is plain ' +
      'prose here \u2014 the one place this contract uses that field the way RFC 6749 defines it, ' +
      'rather than as a coded value. Nothing was consumed, so the session and its allow-list come ' +
      'back and the call can be corrected.',
    connection: 'db-email-otp',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: '' } },
    ],
  },
  {
    id: 'mfa-push-denied',
    label: 'Push denied by the user',
    badge: 'spec',
    categories: ['login', 'errors'],
    expect: 'denied',
    summary:
      'The user taps Deny. Terminal \u2014 access_denied with authorization_rejected, no `next`, ' +
      'no session. A decision, not a failure: a client must NOT re-challenge, which is what ' +
      'separates it from the expiry case that carries the same status and error code.',
    connection: 'db-both',
    mfaPolicy: 'Always',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:challenge:push:v1',
      'action:verify:oob:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:challenge:push:v1', payload: { index: 0 } },
      { action: 'action:verify:oob:v1', payload: { simulate: 'rejected' } },
    ],
  },
  {
    id: 'mfa-push-expired',
    label: 'Push transaction expired',
    badge: 'spec',
    categories: ['login', 'errors'],
    expect: 'denied',
    summary:
      'The transaction lapses before the user answers. Same status and same error as a denial \u2014 ' +
      'only error_description separates them, and the correct client response is the opposite: ' +
      'challenge again rather than give up.',
    connection: 'db-both',
    mfaPolicy: 'Always',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:challenge:push:v1',
      'action:verify:oob:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:challenge:push:v1', payload: { index: 0 } },
      { action: 'action:verify:oob:v1', payload: { simulate: 'expired' } },
    ],
  },
  {
    id: 'mfa-recovery-code',
    label: 'MFA \u2014 recovery code',
    badge: 'spec',
    categories: ['login'],
    expect: 'code',
    demonstrates: 'invalid_code',
    summary:
      'The last-resort factor, and the only one with its own rejection code: a malformed recovery ' +
      'code returns invalid_code rather than the invalid_identifier_or_* pair the credential paths ' +
      'share. Recoverable \u2014 the same `next` comes back.',
    connection: 'db-both',
    mfaPolicy: 'Always',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:challenge:recovery-code:v1',
      'action:challenge:totp:v1',
      'action:verify:recovery-code:v1',
      'action:verify:otp:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:challenge:recovery-code:v1' },
      { action: 'action:verify:recovery-code:v1', payload: { recovery_code: 'SHORT' } },
      { action: 'action:verify:recovery-code:v1', payload: { recovery_code: 'ABCD1234EFGH5678' } },
    ],
  },
  {
    id: 'upstream-outage',
    label: 'Dependency outage is not a wrong password',
    badge: 'spec',
    categories: ['errors'],
    expect: 'server_error',
    summary:
      'The password below is the CORRECT one, but the credential service is down. This is the one ' +
      'negative outcome that is NOT collapsed into the uniform failure: a client seeing ' +
      'invalid_identifier_or_password would re-prompt the user and retry, which against an outage ' +
      'is exactly wrong. No `next`, no rotated session — retry the same call once it recovers.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:verify:password:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234', simulate: 'upstream_error' } },
    ],
  },
  {
    id: 'password-only',
    label: 'Password-only connection, OTP-only client',
    badge: 'spec',
    categories: ['login', 'errors'],
    expect: 'refused',
    summary:
      'The client declares only OTP capabilities; the connection enables only password. ' +
      'Negotiation yields an empty intersection, so initiate refuses rather than leading the user ' +
      'into a flow that can never finish.',
    connection: 'db-password',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'],
    script: [{ action: 'initiate' }],
  },
  {
    id: 'password-switch',
    label: 'Password + OTP — method switching',
    badge: 'spec',
    categories: ['login'],
    expect: 'code',
    demonstrates: 'invalid_identifier_or_password',
    summary:
      'With both methods enabled, `next` carries verify:password AND challenge:email at once, and ' +
      'keeps re-offering both after a failure. Switching needs no server command.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1',
      'action:identify:username:v1',
      'action:verify:password:v1',
      'action:challenge:email:v1',
      'action:verify:otp:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'wrong-one' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
    ],
  },
  {
    id: 'username-path',
    label: 'Username identifier (no OTP available)',
    badge: 'spec',
    categories: ['login'],
    expect: 'continues',
    summary:
      'Identify by username and only password is offered — there is no username_otp, which is why ' +
      'username only became usable once password existed.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: [
      'action:identify:username:v1',
      'action:verify:password:v1',
      'action:challenge:email:v1',
      'action:verify:otp:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:username:v1', payload: { username: 'hazelnutt' } },
    ],
  },
  {
    id: 'mfa-totp',
    label: 'MFA chaining — password then TOTP',
    badge: 'spec',
    categories: ['login'],
    expect: 'code',
    summary:
      'The pipeline pauses a second time for MFA — the same pause/resume contract, one step ' +
      'further down. Watch amrs accumulate.',
    connection: 'db-both',
    mfaPolicy: 'Always',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:challenge:totp:v1',
      'action:challenge:push:v1',
      'action:challenge:recovery-code:v1',
      'action:verify:otp:v1',
      'action:verify:oob:v1',
      'action:verify:recovery-code:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:challenge:totp:v1' },
      { action: 'action:verify:otp:v1', payload: { otp: '123456' } },
    ],
  },
  {
    id: 'mfa-push',
    label: 'MFA — push polling',
    badge: 'spec',
    categories: ['login'],
    expect: 'code',
    summary:
      'The only poll-based factor. PENDING → authorization_pending on the same action; polling too ' +
      'fast gets slow_down without the transaction even being inspected.',
    connection: 'db-both',
    mfaPolicy: 'Always',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:challenge:push:v1',
      'action:verify:oob:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:challenge:push:v1', payload: { index: 0 } },
      { action: 'action:verify:oob:v1' },
      { action: 'action:verify:oob:v1' },
      { action: 'action:verify:oob:v1' },
    ],
  },
  {
    id: 'mfa-none',
    label: 'MFA required, nothing enrolled',
    badge: 'spec',
    categories: ['login', 'errors'],
    expect: 'denied',
    summary:
      'Policy demands a second factor the user does not have. D3 adds no in-flow enrollment, so ' +
      'this is terminal by design.',
    connection: 'db-email-otp',
    mfaPolicy: 'Always',
    nativeSdks: [],
    caps: [
      'action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1',
      'action:challenge:totp:v1', 'action:challenge:push:v1', 'action:challenge:recovery-code:v1',
    ],
    // no-mfa@okta.com exists and authenticates fine, but has nothing enrolled.
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'no-mfa@okta.com' } },
      { action: 'action:challenge:email:v1' },
      { action: 'action:verify:otp:v1', payload: { otp: '123456' } },
    ],
  },
  {
    id: 'signup',
    label: 'Signup — silent, then confirm',
    badge: 'spec',
    categories: ['signup'],
    expect: 'code',
    summary:
      'Signup shares the sign-in response shape by design, so an observer cannot tell which one is ' +
      'happening.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: [
      'action:signup:v1',
      'action:identify:email:v1',
      'action:challenge:email:v1',
      'action:verify:otp:v1',
      'action:enroll:password:v1',
      'action:signup:confirm:v1',
    ],
    script: [
      { action: 'initiate' },
      { action: 'action:signup:v1' },
      { action: 'action:identify:email:v1', payload: { email: 'brand-new@example.com' } },
      { action: 'action:challenge:email:v1' },
      { action: 'action:verify:otp:v1', payload: { otp: '123456' } },
      { action: 'action:enroll:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:signup:confirm:v1' },
    ],
  },
  {
    id: 'federated-path-a',
    label: 'Federated — Home Realm Discovery resolves it',
    badge: 'spec',
    categories: ['federation', 'redirect'],
    browser: true,
    expect: 'code',
    summary:
      'Home Realm Discovery maps the identifier to exactly one federated connection, so the ' +
      'server resolves it without asking the user and the href is already on the first response. ' +
      'Note the action: authn:federated:company-saml:v1 — the CONNECTION name, not the samlp ' +
      'strategy.',
    connection: 'enterprise-saml',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['authn:federated:v1'],
    script: [
      { action: 'initiate' },
      { action: 'authn:federated:company-saml:v1' },
    ],
  },
  {
    id: 'federated-path-b',
    label: 'Federated — no HRD, the user picks',
    badge: 'spec',
    categories: ['federation', 'redirect'],
    browser: true,
    expect: 'code',
    summary:
      'Home Realm Discovery cannot narrow this to one connection — two are eligible — so the ' +
      'choice belongs to the user. Both come back with no href; the client echoes the one that ' +
      'was picked and only then does the server mint a coordination reference. Delete ' +
      'code_challenge from the initiate payload and the request_uri disappears — the draft forbids ' +
      'returning one without PKCE.',
    connection: 'social-multi',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['authn:federated:v1'],
    script: [
      { action: 'initiate' },
      { action: 'authn:federated:github:v1' },
      { action: 'authn:federated:github:v1' },
    ],
  },
  {
    id: 'federated-same-strategy',
    label: 'Two connections, one strategy',
    badge: 'spec',
    categories: ['federation'],
    expect: 'continues',
    summary:
      'The case REDIR cites to justify specialising on connection rather than strategy. Keyed on ' +
      'strategy these two OIDC connections would collapse into one action and the second IdP ' +
      'would be unreachable.',
    connection: 'enterprise-multi-oidc',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['authn:federated:v1'],
    script: [{ action: 'initiate' }],
  },
  {
    id: 'federated-abandoned',
    label: 'Federated — abandoned WebView',
    badge: 'spec',
    categories: ['federation', 'redirect', 'errors'],
    browser: true,
    expect: 'code',
    summary:
      'The user closes the browser without finishing. The server does not ask the client to ' +
      'remember anything — it mints a fresh reference and returns the same action, ' +
      'indistinguishable from the original response.',
    connection: 'enterprise-saml',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['authn:federated:v1'],
    script: [
      { action: 'initiate' },
      { action: 'authn:federated:company-saml:v1', payload: { simulate: 'abandoned' } },
      { action: 'authn:federated:company-saml:v1' },
    ],
  },
  {
    id: 'native-social',
    label: 'Native social vs redirect',
    badge: 'spec',
    categories: ['federation'],
    expect: 'code',
    summary:
      'Same Google connection, two answers. Declare the native SDK and the server offers ' +
      'authn:ns:google:v1 with no href at all; drop it and you get a browser handoff instead.',
    connection: 'social-google',
    mfaPolicy: 'Never',
    nativeSdks: ['google-oauth2'],
    caps: ['authn:federated:v1', 'authn:ns:google:v1'],
    script: [
      { action: 'initiate' },
      {
        action: 'authn:ns:google:v1',
        payload: {
          idp_artifact: 'ya29.a0ARrdaM-google-access-token',
          idp_artifact_type: 'urn:ietf:params:oauth:token-type:access_token',
        },
      },
    ],
  },
  {
    id: 'captcha-adaptive',
    label: 'Bot detection — adaptive CAPTCHA',
    badge: 'spec',
    categories: ['redirect', 'bot'],
    browser: true,
    expect: 'code',
    summary:
      'The challenge fires after the identifier and before any credential, so the user proves ' +
      'humanness once and the rest of the login stays in-app. No credential is offered alongside ' +
      'it — the challenge replaces that step.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    botDetection: 'adaptive',
    caps: ['action:identify:email:v1', 'action:verify:password:v1', 'action:interaction:captcha:verify:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:interaction:captcha:verify:v1' },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
    ],
  },
  {
    id: 'captcha-single-use',
    label: 'CAPTCHA clearance is single-use',
    badge: 'spec',
    categories: ['redirect', 'bot'],
    browser: true,
    expect: 'code',
    summary:
      'Solve the CAPTCHA, then get the password wrong. The session resets to captcha-required — ' +
      'not back to the credential step. Solve once and spray passwords is exactly what this closes.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    botDetection: 'adaptive',
    caps: ['action:identify:email:v1', 'action:verify:password:v1', 'action:interaction:captcha:verify:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:interaction:captcha:verify:v1' },
      { action: 'action:verify:password:v1', payload: { password: 'wrong-one' } },
      { action: 'action:interaction:captcha:verify:v1' },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
    ],
  },
  {
    id: 'captcha-block',
    label: 'Bot detection — block mode',
    badge: 'spec',
    categories: ['errors', 'bot'],
    expect: 'continues',
    demonstrates: 'invalid_identifier_or_password',
    summary:
      'The password below is the CORRECT one. Block mode answers it exactly as it answers a wrong ' +
      'one, so the client cannot tell "you are a bot" from "wrong password" — and a false positive ' +
      'has no recourse.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    botDetection: 'block',
    caps: ['action:identify:email:v1', 'action:verify:password:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
    ],
  },
  {
    id: 'post-login-form',
    label: 'Post-login form — redirect to web',
    badge: 'spec',
    categories: ['redirect', 'forms'],
    browser: true,
    expect: 'code',
    summary:
      'Authentication finishes, then a post-login Action calls api.prompt.render() and the ' +
      'pipeline pauses a second time. The resume is the same action that was offered — FORMS ' +
      'answers with form:verify:v1 instead, which the allow-list would have had to special-case.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    postLogin: 'form',
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:interaction:form:v1',
          ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:interaction:form:v1' },
    ],
  },
  {
    id: 'post-login-form-native',
    label: 'Post-login form — native SDK',
    badge: 'spec',
    categories: ['redirect', 'forms'],
    expect: 'code',
    summary:
      'The same journey, the same binding, the same resume check — but declaring ' +
      'action:interaction:form:native:v1 swaps the href for form_id + state and the form renders ' +
      'inline. No WebView, no form_token, no iron-seal.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    postLogin: 'form',
    caps: [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:interaction:form:v1',
      'action:interaction:form:native:v1',
          ],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:interaction:form:v1' },
    ],
  },
  {
    id: 'post-login-redirect',
    label: 'Post-login redirect (Actions)',
    badge: 'spec',
    categories: ['redirect', 'actions'],
    browser: true,
    expect: 'code',
    summary:
      'api.redirect.sendUserTo(). The deep link back carries nothing — no token, no code. The ' +
      'authorization code arrives only from the resume call, which is the invariant the whole ' +
      'escape-to-web pattern rests on.',
    connection: 'db-both',
    mfaPolicy: 'Never',
    nativeSdks: [],
    postLogin: 'web',
    caps: ['action:identify:email:v1', 'action:verify:password:v1', 'action:interaction:web:v1'],
    script: [
      { action: 'initiate' },
      { action: 'action:identify:email:v1', payload: { email: 'hazel.nutt@okta.com' } },
      { action: 'action:verify:password:v1', payload: { password: 'Abcd@1234' } },
      { action: 'action:interaction:web:v1' },
    ],
  },
  {
    id: 'federated-then-form',
    label: 'Chained — federation then a form',
    badge: 'spec',
    categories: ['federation', 'redirect', 'forms'],
    browser: true,
    expect: 'code',
    summary:
      'Two web legs in one session, from REDIR\'s composability table. Enterprise SSO in the ' +
      'browser, back into the app, then straight out to a hosted form — each with its own ' +
      'coordination reference.',
    connection: 'enterprise-saml',
    mfaPolicy: 'Never',
    nativeSdks: [],
    postLogin: 'form',
    caps: [
      'authn:federated:v1',
      'action:interaction:form:v1',
          ],
    script: [
      { action: 'initiate' },
      { action: 'authn:federated:company-saml:v1' },
      { action: 'action:interaction:form:v1' },
    ],
  },
  {
    id: 'passkey-eager',
    label: 'Passkey — eager challenge block',
    badge: 'spec',
    categories: ['login'],
    expect: 'continues',
    summary:
      'The passkey block comes back in the FIRST response, next to the identify actions. That is ' +
      'what makes conditional mediation (passkey autofill) possible.',
    connection: 'db-full',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: [
      'authn:passkey:v1',
      'action:identify:email:v1',
      'action:identify:username:v1',
      'action:verify:password:v1',
      'action:challenge:email:v1',
      'action:verify:otp:v1',
    ],
    script: [{ action: 'initiate' }],
  },
];

export const byScenarioId = (id) => SCENARIOS.find((s) => s.id === id);
