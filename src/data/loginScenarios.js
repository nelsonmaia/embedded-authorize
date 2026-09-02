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
    summary:
      'The only flow that completes a login end to end today. Verified against a real tenant.',
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
    summary:
      'Five wrong codes. The first four are recoverable; the fifth is terminal and drops the ' +
      'session entirely.',
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
    id: 'out-of-order',
    label: 'Out-of-order action (known bug)',
    badge: 'live',
    summary:
      'Skip the challenge and call verify directly. The allow-list refuses it — but with a 500 ' +
      'instead of invalid_request. Reproduced from a real tenant.',
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
    id: 'password-only',
    label: 'Password-only connection (blocked today)',
    badge: 'spec',
    summary:
      'What nearly every existing tenant looks like. Negotiation yields an empty intersection, so ' +
      'initiate fails — this is the gap the Password RFD exists to close.',
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
    id: 'federated-redirect',
    label: 'Federated — redirect to web',
    badge: 'spec',
    summary:
      'Enterprise SAML has no native path, so it always hands off to a browser. The IdP round-trip ' +
      'is entirely opaque to the app.',
    connection: 'enterprise-saml',
    mfaPolicy: 'Never',
    nativeSdks: [],
    caps: ['authn:federated:v1', 'authn:oauth2:v1', 'action:interaction:web:v1'],
    script: [{ action: 'initiate' }],
  },
  {
    id: 'native-social',
    label: 'Native social vs redirect',
    badge: 'spec',
    summary:
      'Same Google connection, two answers. Declare the native SDK and the server offers ' +
      'authn:ns:google:v1; drop it and you get a browser handoff instead.',
    connection: 'social-google',
    mfaPolicy: 'Never',
    nativeSdks: ['google-oauth2'],
    caps: ['authn:federated:v1', 'authn:oauth2:v1', 'authn:ns:google:v1'],
    script: [{ action: 'initiate' }],
  },
  {
    id: 'passkey-eager',
    label: 'Passkey — eager challenge block',
    badge: 'spec',
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
