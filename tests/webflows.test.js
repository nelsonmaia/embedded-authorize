/**
 * The escape-to-web cases: federation, native social, CAPTCHA, forms, Actions redirects.
 *
 * These are all `status: 'spec'` capabilities — nothing here has been verified against a tenant,
 * because none of it is built yet. What the tests pin is the SETTLED contract: where the three
 * RFDs contradicted each other or the IETF draft, `DECISIONS` in spec.js records the resolution
 * and these tests hold the engine to it.
 *
 * Several assertions therefore contradict the source documents on purpose. Each one says which
 * document it is overriding and why, so a reader who finds the other answer in REDIR or FORMS
 * knows it was considered rather than missed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshState, initiate, submit, sessionPayload, MAX_OTP_ATTEMPTS } from '../src/engine/engine.js';
import {
  CONNECTION_PRESETS,
  DECISIONS,
  ERRORS,
  byId,
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_BY_PROVIDER,
} from '../src/data/spec.js';
import { SCENARIOS } from '../src/data/loginScenarios.js';
import { SIGNUP_SCENARIOS } from '../src/data/signupPrd.js';
import { simulatorTransport } from '../src/transports/simulatorTransport.js';

const preset = (id) => CONNECTION_PRESETS.find((c) => c.id === id);

const start = (connectionId, caps, opts = {}) => {
  const state = freshState({ connection: preset(connectionId), declaredCaps: caps, ...opts });
  const first = initiate(state);
  return { state, first };
};

const actions = (res) => (res.body.next ?? []).map((n) => n.action);
const entry = (res, action) => (res.body.next ?? []).find((n) => n.action === action);

/* ── federation ─────────────────────────────────────────────────────────── */

test('federation specialises on the connection NAME, not the strategy', () => {
  const { first } = start('enterprise-saml', ['authn:federated:v1']);

  // The connection is named company-saml; its strategy is samlp. REDIR encodes the name.
  assert.deepEqual(actions(first), ['authn:federated:company-saml:v1']);
});

test('two connections sharing one strategy stay separately reachable', () => {
  const { first } = start('enterprise-multi-oidc', ['authn:federated:v1']);

  // The case REDIR cites to justify the rule. Keyed on strategy both would collapse into a
  // single authn:federated:oidc:v1 and globex would be unreachable.
  assert.deepEqual(actions(first), [
    'authn:federated:acme-oidc:v1',
    'authn:federated:globex-oidc:v1',
  ]);
});

test('Path A — one eligible connection resolves without asking, href on the first response', () => {
  const { state, first } = start('enterprise-saml', ['authn:federated:v1']);

  const only = entry(first, 'authn:federated:company-saml:v1');
  assert.match(only.href, /^https:\/\/\{\{tenant\}\}\.auth0\.com\/authorize\?request_uri=urn:ietf:params:oauth:request_uri:fed_/);

  // Resuming on the same action completes the leg. The resume carries no artifact at all —
  // the IdP tokens went to the token vault server-side.
  const done = submit(state, 'authn:federated:company-saml:v1', {});
  assert.equal(done.status, 200);
  assert.ok(done.body.authorization_code);
});

test('Path B — ambiguous choice returns no href until the client picks', () => {
  const { state, first } = start('social-multi', ['authn:federated:v1']);

  assert.deepEqual(actions(first), [
    'authn:federated:google-oauth2:v1',
    'authn:federated:github:v1',
  ]);
  for (const n of first.body.next) {
    assert.equal(n.href, undefined, `${n.action} must not carry an href before the user chooses`);
  }

  // The client echoes the chosen action; only now is a coordination reference minted.
  const chosen = submit(state, 'authn:federated:github:v1', {});
  assert.equal(chosen.status, 403);
  assert.match(entry(chosen, 'authn:federated:github:v1').href, /request_uri=urn:ietf:params:oauth:request_uri:fed_/);

  const done = submit(state, 'authn:federated:github:v1', {});
  assert.equal(done.status, 200);
});

/** Initiate with PKCE, which is what makes a request_uri legal to return. */
const startWithPkce = (connectionId, caps, opts = {}) => {
  const state = freshState({ connection: preset(connectionId), declaredCaps: caps, ...opts });
  const first = initiate(state, { code_challenge: 'E9Melhoa2Ow', code_challenge_method: 'S256' });
  return { state, first };
};

test('a pause that opens a browser is redirect_to_web with a request_uri', () => {
  // The draft's usage text names these cases directly: "The authorization server may choose to
  // interact directly with the user based on a risk assessment, the introduction of a new
  // authentication method not supported in the application, or to handle an exception flow such
  // as account recovery."
  const pauses = [
    (() => {
      const { state } = startWithPkce('social-multi', ['authn:federated:v1']);
      return submit(state, 'authn:federated:github:v1', {});
    })(),
    (() => {
      const { state } = startWithPkce('db-both', PWD_CAPS, { botDetection: 'adaptive' });
      return submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
    })(),
    (() => {
      const { state } = startWithPkce('db-both', FORM_CAPS, { postLogin: 'form' });
      submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
      return submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
    })(),
    (() => {
      const { state } = startWithPkce('db-both', [...PWD_CAPS, 'action:interaction:web:v1'], { postLogin: 'web' });
      submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
      return submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
    })(),
    startWithPkce('enterprise-saml', ['authn:federated:v1']).first, // Path A, on initiate
  ];

  for (const res of pauses) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'redirect_to_web', JSON.stringify(res.body.next));
    assert.match(res.body.request_uri, /^urn:ietf:params:oauth:request_uri:/);
    assert.ok(res.body.auth_session, 'the session still travels — this is a pause, not a restart');
    assert.ok(res.body.next?.length, 'and so does the action to resume on');
  }
});

test('no PKCE at initiate means no request_uri', () => {
  // "If the client does not include a PKCE code_challenge in the initial authorization challenge
  // request, the authorization server MUST NOT return a request_uri in the redirect_to_web error
  // response, as that would effectively be the same as a PAR request without PKCE."
  const { first } = start('enterprise-saml', ['authn:federated:v1']); // no code_challenge

  assert.equal(first.body.error, 'redirect_to_web');
  assert.equal(first.body.request_uri, undefined);
  // The href still carries the reference, so the flow is not broken — only the draft-defined
  // parameter is withheld, and the note says why.
  assert.match(entry(first, 'authn:federated:company-saml:v1').href, /request_uri=urn:/);
  assert.match(first.note, /code_challenge/);
});

test('a leg rendered in-app is not redirect_to_web', () => {
  // The native Forms SDK renders inline. Nothing leaves the app, so the code that means "you must
  // leave the app" would be a lie.
  const { state } = startWithPkce('db-both', [...FORM_CAPS, 'action:interaction:form:native:v1'], {
    postLogin: 'form',
  });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const form = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.equal(form.body.error, 'insufficient_authorization');
  assert.equal(form.body.request_uri, undefined);
  assert.equal(entry(form, 'action:interaction:form:v1').href, undefined);
});

test('an in-app pause stays a plain continuation', () => {
  // Nothing about OTP, password or MFA involves a browser.
  const { state } = startWithPkce('db-email-otp', [
    'action:identify:email:v1',
    'action:challenge:email:v1',
    'action:verify:otp:v1',
  ]);
  const identified = submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  assert.equal(identified.body.error, 'insufficient_authorization');

  const challenged = submit(state, 'action:challenge:email:v1', {});
  assert.equal(challenged.body.error, 'insufficient_authorization');
  assert.equal(challenged.body.request_uri, undefined);
});

test('every web-leg descriptor carries its lifetime', () => {
  // expires_in is the draft's OPTIONAL parameter for the reference lifetime. Without it a client
  // cannot tell an expired href from a broken one.
  const { first } = start('enterprise-saml', ['authn:federated:v1']);
  assert.equal(entry(first, 'authn:federated:company-saml:v1').expires_in, 300);

  const { state } = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });
  const captcha = submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  assert.equal(entry(captcha, 'action:interaction:captcha:verify:v1').expires_in, 90);
});

test('an abandoned web leg comes back as the same action with a fresh reference', () => {
  const { state, first } = start('enterprise-saml', ['authn:federated:v1']);
  const original = entry(first, 'authn:federated:company-saml:v1').href;

  const retry = submit(state, 'authn:federated:company-saml:v1', { simulate: 'abandoned' });
  const reissued = entry(retry, 'authn:federated:company-saml:v1').href;

  // Same action, same shape, different reference — "indistinguishable from the original
  // response". The client never had to remember the old request_uri.
  assert.equal(retry.body.error, 'redirect_to_web');
  assert.notEqual(reissued, original);
  assert.match(reissued, /request_uri=urn:ietf:params:oauth:request_uri:fed_/);

  assert.equal(submit(state, 'authn:federated:company-saml:v1', {}).status, 200);
});

test('a native SDK suppresses the redirect for that connection only', () => {
  const withSdk = start('social-multi', ['authn:federated:v1', 'authn:ns:google:v1'], {
    nativeSdks: ['google-oauth2'],
  });

  // Google goes native; GitHub has no native path declared, so it still hands off.
  assert.deepEqual(actions(withSdk.first), ['authn:federated:github:v1', 'authn:ns:google:v1']);
});

test('enterprise connections never get a native path', () => {
  // oidc is in REDIR's enterprise list. Classified as social it would have been offered a
  // native-social action it has no SDK for.
  const { first } = start('enterprise-multi-oidc', ['authn:federated:v1', 'authn:ns:google:v1'], {
    nativeSdks: ['oidc', 'google-oauth2'],
  });

  assert.deepEqual(actions(first), [
    'authn:federated:acme-oidc:v1',
    'authn:federated:globex-oidc:v1',
  ]);
});

/* ── native social ──────────────────────────────────────────────────────── */

test('native social needs an artifact and opens no web leg', () => {
  const { state, first } = start('social-google', ['authn:ns:google:v1'], {
    nativeSdks: ['google-oauth2'],
  });

  assert.deepEqual(actions(first), ['authn:ns:google:v1']);
  assert.equal(entry(first, 'authn:ns:google:v1').href, undefined);
  assert.equal(sessionPayload(state).embedded_auth_state.web_leg, null);

  const missing = submit(state, 'authn:ns:google:v1', {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.error_description, /idp_artifact/);

  const done = submit(state, 'authn:ns:google:v1', {
    idp_artifact: 'ya29.test',
    idp_artifact_type: ARTIFACT_TYPES.accessToken,
  });
  assert.equal(done.status, 200);
});

test('the artifact type travels with the artifact', () => {
  const untyped = start('social-google', ['authn:ns:google:v1'], { nativeSdks: ['google-oauth2'] });
  const rejected = submit(untyped.state, 'authn:ns:google:v1', { idp_artifact: 'ya29.test' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error_description, /idp_artifact_type/);

  // Google returns an access token; claiming Apple's authz-code URN is refused rather than
  // silently accepted, which is the whole reason the type is explicit.
  const mismatched = submit(untyped.state, 'authn:ns:google:v1', {
    idp_artifact: 'ya29.test',
    idp_artifact_type: ARTIFACT_TYPES.appleAuthzCode,
  });
  assert.equal(mismatched.status, 400);
});

test('access tokens use the RFC 8693 URN; only Apple keeps a proprietary one', () => {
  assert.equal(ARTIFACT_TYPES.accessToken, 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(ARTIFACT_TYPE_BY_PROVIDER.google, ARTIFACT_TYPES.accessToken);
  assert.equal(ARTIFACT_TYPE_BY_PROVIDER.facebook, ARTIFACT_TYPES.accessToken);

  // Apple returns an authorization code, which RFC 8693 has no registered type for. This is the
  // URN REDIR already documents.
  assert.equal(
    ARTIFACT_TYPE_BY_PROVIDER.apple,
    'http://auth0.com/oauth/token-type/apple-authz-code'
  );

  const { state } = start('social-google', ['authn:ns:apple:v1'], { nativeSdks: ['apple'] });
  assert.equal(state.connection.strategy, 'google-oauth2'); // apple is not on this connection
});

test('the retired id_token spelling is answered with the correction', () => {
  const { state } = start('social-google', ['authn:ns:google:v1'], { nativeSdks: ['google-oauth2'] });

  // REDIR's worked example sends `id_token`. It still parses so the documented request does not
  // simply fail, but the response says the name is retired rather than accepting it silently.
  const done = submit(state, 'authn:ns:google:v1', { id_token: 'ya29.test' });
  assert.equal(done.status, 200);
  assert.match(done.note, /retired/);
  assert.match(done.note, /idp_artifact_type/);
});

/* ── bot detection ──────────────────────────────────────────────────────── */

const PWD_CAPS = ['action:identify:email:v1', 'action:verify:password:v1'];

test('adaptive CAPTCHA fires after identify and before any credential', () => {
  const { state } = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });

  const afterId = submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  assert.deepEqual(actions(afterId), ['action:interaction:captcha:verify:v1']);
  assert.match(entry(afterId, 'action:interaction:captcha:verify:v1').href, /\/captcha\?request_uri=/);

  // No credential was offered alongside it — the challenge replaces that step, it does not
  // accompany it.
  assert.equal(actions(afterId).includes('action:verify:password:v1'), false);

  const cleared = submit(state, 'action:interaction:captcha:verify:v1', {});
  assert.deepEqual(actions(cleared), ['action:verify:password:v1']);
  assert.equal(sessionPayload(state).embedded_auth_state.captcha_clearance.single_use, true);

  assert.equal(submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' }).status, 200);
});

test('a decoy identifier reaches the same CAPTCHA as a real user', () => {
  const real = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });
  const decoy = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });

  const a = submit(real.state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  const b = submit(decoy.state, 'action:identify:email:v1', { email: 'nobody-xyz@example.com' });

  // Branching the challenge on whether the user exists would be an enumeration oracle.
  assert.deepEqual(actions(a), actions(b));
  assert.equal(a.status, b.status);
  assert.equal(a.body.error, b.body.error);
});

test('a wrong password burns the CAPTCHA clearance', () => {
  const { state } = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  submit(state, 'action:interaction:captcha:verify:v1', {});

  const wrong = submit(state, 'action:verify:password:v1', { password: 'nope' });

  // Back to captcha-required, NOT back to the credential step. Solve once / guess many is the
  // attack this closes, so the next allow-list must not contain the password action.
  assert.deepEqual(actions(wrong), ['action:interaction:captcha:verify:v1']);
  assert.equal(sessionPayload(state).embedded_auth_state.captcha_clearance, null);

  // And a second solve really is required before the next attempt is even accepted.
  const skipped = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.equal(skipped.status, 400, 'the allow-list should refuse the credential until re-solved');
});

test('a failed CAPTCHA reissues rather than terminating', () => {
  const { state } = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });
  const challenged = submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  const before = entry(challenged, 'action:interaction:captcha:verify:v1').href;

  const retry = submit(state, 'action:interaction:captcha:verify:v1', { simulate: 'failed' });
  assert.notEqual(entry(retry, 'action:interaction:captcha:verify:v1').href, before);
  assert.equal(submit(state, 'action:interaction:captcha:verify:v1', {}).status, 403);
});

test('block mode answers a correct password exactly as it answers a wrong one', () => {
  const good = start('db-both', PWD_CAPS, { botDetection: 'block' });
  const bad = start('db-both', PWD_CAPS, { botDetection: 'block' });
  submit(good.state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  submit(bad.state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const a = submit(good.state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  const b = submit(bad.state, 'action:verify:password:v1', { password: 'wrong' });

  // No oracle: the bodies differ only in the rotated session value.
  assert.equal(a.status, b.status);
  assert.deepEqual({ ...a.body, auth_session: null }, { ...b.body, auth_session: null });
  assert.equal(a.body.error_description, 'invalid_identifier_or_password');
});

test('actions mode challenges after the credential, then completes', () => {
  const { state } = start('db-both', PWD_CAPS, { botDetection: 'actions' });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const challenged = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.deepEqual(actions(challenged), ['action:interaction:captcha:verify:v1']);

  const done = submit(state, 'action:interaction:captcha:verify:v1', {});
  assert.equal(done.status, 200);
});

/* ── post-login interactions ────────────────────────────────────────────── */

const FORM_CAPS = [...PWD_CAPS, 'action:interaction:form:v1', 'action:interaction:form:v1'];

test('a post-login form pauses after authentication, before the code', () => {
  const { state } = start('db-both', FORM_CAPS, { postLogin: 'form' });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const form = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.equal(form.status, 403);
  assert.deepEqual(actions(form), ['action:interaction:form:v1']);
  assert.match(entry(form, 'action:interaction:form:v1').href, /\/form\?request_uri=urn:.*form_/);

  const done = submit(state, 'action:interaction:form:v1', {});
  assert.equal(done.status, 200);
});

test('every leg resumes on the action it was offered under', () => {
  // The settled rule. Before it, forms alone resumed on an action the server never advertised,
  // which forced a carve-out in the `next` allow-list D2 #3 relies on.
  const legs = [
    (() => {
      const { state } = start('db-both', FORM_CAPS, { postLogin: 'form' });
      submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
      const paused = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
      return { state, paused };
    })(),
    (() => {
      const { state } = start('db-both', [...PWD_CAPS, 'action:interaction:web:v1'], { postLogin: 'web' });
      submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
      const paused = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
      return { state, paused };
    })(),
    (() => {
      const { state } = start('db-both', PWD_CAPS, { botDetection: 'adaptive' });
      const paused = submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
      return { state, paused };
    })(),
    (() => {
      const { state, first } = start('enterprise-saml', ['authn:federated:v1']);
      return { state, paused: first };
    })(),
  ];

  for (const { state, paused } of legs) {
    const offered = actions(paused);
    assert.equal(offered.length, 1, JSON.stringify(offered));
    // Sending back exactly what was offered is always accepted — never refused by the allow-list.
    assert.notEqual(submit(state, offered[0], {}).status, 400, `${offered[0]} was refused`);
  }
});

test('the retired forms verify action is gone', () => {
  const { state } = start('db-both', FORM_CAPS, { postLogin: 'form' });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });

  // It is not in the registry, and the allow-list refuses it like any other unoffered action —
  // no special case anywhere in the engine.
  assert.equal(byId('action:interaction:form:verify:v1'), undefined);
  assert.equal(submit(state, 'action:interaction:form:verify:v1', {}).status, 400);
});

test('declaring the native form capability swaps href for form_id + journey_id', () => {
  const { state } = start('db-both', [...FORM_CAPS, 'action:interaction:form:native:v1'], {
    postLogin: 'form',
  });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const form = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  const descriptor = entry(form, 'action:interaction:form:v1');

  // Same action id, same journey, same resume check — only the render path differs.
  assert.equal(descriptor.href, undefined);
  assert.ok(descriptor.form_id);
  assert.ok(descriptor.journey_id);
  // `state` is RFC 6749's anti-CSRF parameter and must not be overloaded for the journey binding.
  assert.equal(descriptor.state, undefined);
  assert.equal(submit(state, 'action:interaction:form:v1', {}).status, 200);
});

test('an Actions redirect resumes on its own action and only then issues the code', () => {
  const { state } = start('db-both', [...PWD_CAPS, 'action:interaction:web:v1'], { postLogin: 'web' });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const web = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.deepEqual(actions(web), ['action:interaction:web:v1']);
  assert.equal(web.body.authorization_code, undefined, 'the callback carries no code');
  assert.match(entry(web, 'action:interaction:web:v1').href, /\/continue\?request_uri=.*&redirect_to=/);

  const done = submit(state, 'action:interaction:web:v1', {});
  assert.equal(done.status, 200);
  assert.ok(done.body.authorization_code);
});

test('MFA runs before the post-login form, not after it', () => {
  const { state } = start(
    'db-both',
    [...FORM_CAPS, 'action:challenge:totp:v1', 'action:verify:otp:v1'],
    { postLogin: 'form', mfaPolicy: 'Always' }
  );
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const mfa = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.deepEqual(actions(mfa), ['action:challenge:totp:v1']);

  submit(state, 'action:challenge:totp:v1', {});
  const form = submit(state, 'action:verify:otp:v1', { otp: '123456' });
  assert.deepEqual(actions(form), ['action:interaction:form:v1']);
  assert.equal(submit(state, 'action:interaction:form:v1', {}).status, 200);
});

test('federation chains into a post-login form', () => {
  // REDIR's composability table, "Federation (web) → Post-login form (web)".
  const { state } = start(
    'enterprise-saml',
    ['authn:federated:v1', 'action:interaction:form:v1', 'action:interaction:form:v1'],
    { postLogin: 'form' }
  );

  const form = submit(state, 'authn:federated:company-saml:v1', {});
  assert.deepEqual(actions(form), ['action:interaction:form:v1']);
  assert.equal(submit(state, 'action:interaction:form:v1', {}).status, 200);
});

/* ── signup enrollment ──────────────────────────────────────────────────── */

test('enroll:password completes the signup fork it was always offered on', () => {
  const { state } = start(
    'db-both',
    [
      'action:signup:v1',
      'action:identify:email:v1',
      'action:challenge:email:v1',
      'action:verify:otp:v1',
      'action:enroll:password:v1',
      'action:signup:confirm:v1',
    ],
    {}
  );

  submit(state, 'action:signup:v1', {});
  submit(state, 'action:identify:email:v1', { email: 'brand-new@example.com' });
  submit(state, 'action:challenge:email:v1', {});
  const enrol = submit(state, 'action:verify:otp:v1', { otp: '123456' });
  assert.equal(actions(enrol).includes('action:enroll:password:v1'), true);

  const weak = submit(state, 'action:enroll:password:v1', { password: 'short' });
  // Reuses PWD's enum rather than inventing a policy-rejection code. See KNOWN_GAPS.
  assert.equal(weak.body.error_description, 'invalid_identifier_or_password');

  const set = submit(state, 'action:enroll:password:v1', { password: 'Abcd@1234' });
  assert.deepEqual(actions(set), ['action:signup:confirm:v1']);
  assert.equal(submit(state, 'action:signup:confirm:v1', {}).status, 200);
});

/* ── registry hygiene ───────────────────────────────────────────────────── */

test('authn:oauth2:v1 is gone from the registry', () => {
  // It was cited to REDIR, which never mentions it: REDIR models the handoff entirely as
  // authn:federated:<connection>:v1, with redirect_to_web as an error code rather than an action.
  assert.equal(byId('authn:oauth2:v1'), undefined);
});

test('specialised federation actions resolve back to the declared capability', () => {
  // The console seeds request payloads through byId(); a minted action must not come back empty.
  assert.equal(byId('authn:federated:company-saml:v1').id, 'authn:federated:v1');
});

/* ── every scenario in the picker actually plays ────────────────────────── */

/**
 * Drive a scenario the way ConsoleView does: take the offered actions, pick the one the script
 * names, prefill it with seedFor(), send THAT.
 *
 * Replaying the script payloads directly — as this test used to — proves nothing about the app,
 * because the console never sends the script. It sends whatever seedFor() produced. Seven
 * scenarios passed that weaker test while demonstrating the opposite of their label in the UI.
 */
async function driveScenario(scenario) {
  const t = simulatorTransport({ scenario });
  const trail = [];
  let res = await t.start();
  trail.push(res);

  for (let i = 1; i < (scenario.script ?? []).length; i++) {
    const offered = res.body?.next ?? [];
    if (!offered.length) break;

    const wanted = scenario.script[i].action;
    // The console offers exactly what the server offered. A scripted action that is not on that
    // list is the point of some scenarios (out-of-order), so fall back to sending it anyway.
    const entryFor = offered.find((n) => n.action === wanted) ?? { action: wanted };

    // Honour poll_in_ms, because a client that ignores it gets slow_down — the pacing is enforced
    // server-side against the previous response, exactly as a real polling client would find.
    if (entryFor.poll_in_ms) await new Promise((r) => setTimeout(r, entryFor.poll_in_ms + 50));

    res = await t.send(t.seedFor(entryFor));
    trail.push(res);
  }
  return trail;
}

/** Walking a scenario can involve real waits, so each is driven once and shared. */
const trails = new Map();
const driveLikeTheConsole = async (scenario) => {
  if (!trails.has(scenario.id)) trails.set(scenario.id, await driveScenario(scenario));
  return trails.get(scenario.id);
};

const OUTCOMES = {
  code: (r) => r.status === 200 && !!r.body.authorization_code,
  denied: (r) => r.status === 403 && r.body.error === 'access_denied',
  refused: (r) => r.status === 400 && r.body.error === 'invalid_request',
  continues: (r) => r.status === 403 && r.body.error === 'insufficient_authorization',
  handoff: (r) => r.status === 403 && r.body.error === 'redirect_to_web',
  invalid_session: (r) => r.status === 400 && r.body.error === 'invalid_session',
  server_error: (r) => r.status === 500 && r.body.error === 'server_error',
};

test('a refused action leaves the flow usable; a refused session does not', () => {
  const { state, first } = start('db-email-otp', [
    'action:identify:email:v1',
    'action:challenge:email:v1',
    'action:verify:otp:v1',
  ]);

  // Out of order: nothing changed, so the allow-list is restated and the client can correct itself.
  const outOfOrder = submit(state, 'action:verify:otp:v1', { otp: '123456' });
  assert.equal(outOfOrder.body.error, 'invalid_request');
  assert.deepEqual(outOfOrder.body.next, first.body.next);
  assert.equal(submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' }).status, 403);

  // A bad session cannot be answered with a usable one — that would defeat the rejection.
  const badSession = submit(state, 'action:challenge:email:v1', { auth_session: 'spec-session-1' });
  assert.equal(badSession.body.error, 'invalid_session');
  assert.equal(badSession.body.next, undefined);
  assert.equal(badSession.body.auth_session, undefined);
});

test('every scenario reaches the outcome its label promises', async () => {
  for (const scenario of SCENARIOS) {
    const trail = await driveLikeTheConsole(scenario);
    const last = trail.at(-1);

    assert.ok(scenario.expect, `${scenario.id} declares no expected outcome`);
    assert.ok(
      OUTCOMES[scenario.expect](last),
      `${scenario.id} ("${scenario.label}") expected ${scenario.expect}, got ` +
        `${last.status} ${JSON.stringify(last.body)}`
    );

    if (scenario.demonstrates) {
      const surfaced = trail.some(
        (r) => r.body?.error === scenario.demonstrates || r.body?.error_description === scenario.demonstrates
      );
      assert.ok(surfaced, `${scenario.id} never surfaced ${scenario.demonstrates}`);
    }
  }
});

test('no scenario reaches an unimplemented handler', async () => {
  for (const scenario of SCENARIOS) {
    for (const res of await driveLikeTheConsole(scenario)) {
      assert.notEqual(
        res.body?.error,
        'not_implemented',
        `${scenario.id} reached an unimplemented handler: ${JSON.stringify(res.note ?? res.body)}`
      );
      // The outage scenario returns 500 on purpose — that is the whole thing it demonstrates.
      if (scenario.expect !== 'server_error') {
        assert.notEqual(res.status, 500, `${scenario.id} returned an unexpected server_error`);
      }
    }
  }
});

test('the lockout scenario really locks out', async () => {
  // The one that caught this: the console prefilled a code that succeeded on the first try, so a
  // scenario named "Wrong code → lockout" issued an authorization code instead.
  const trail = await driveLikeTheConsole(SCENARIOS.find((s) => s.id === 'otp-lockout'));

  assert.equal(trail.filter((r) => r.body?.error_description === 'invalid_identifier_or_code').length, 4);
  assert.equal(trail.at(-1).body.error_description, 'too_many_wrong_otp_attempts');
  assert.ok(!trail.some((r) => r.body?.authorization_code), 'no code should ever be issued here');
});

test('the decoy scenario really uses an identifier that does not exist', async () => {
  const trail = await driveLikeTheConsole(SCENARIOS.find((s) => s.id === 'otp-decoy'));

  // Seeded from the registry it identified as hazel.nutt@okta.com — a real user — and the flow
  // stopped being an anti-enumeration demo at all.
  const identify = trail[1].request.body;
  assert.equal(identify.email, 'nobody-xyz-9931@example.com');
  assert.match(trail[2].note, /DECOY/);
});

/* ── the settled contract ───────────────────────────────────────────────── */

test('the draft supplies the error vocabulary it defines', () => {
  // insufficient_authorization MUST be 403 per the draft; invalid_session is its code for a bad
  // auth_session, which the tenant currently answers with invalid_grant.
  assert.equal(ERRORS.insufficient_authorization.http, 403);
  assert.ok(ERRORS.invalid_session, 'the draft defines invalid_session');
  assert.equal(ERRORS.invalid_session.source, 'DRAFT');

  // Both browser-handoff codes are 403 continuations of the same flow.
  assert.equal(ERRORS.redirect_to_web.kind, 'handoff');
  assert.equal(ERRORS.redirect_to_web.http, 403);
});

test('every decision records what it overrode and on what authority', () => {
  assert.ok(DECISIONS.length >= 6);
  for (const d of DECISIONS) {
    assert.ok(d.title && d.conflict && d.decision && d.why, `incomplete decision: ${d.title}`);
    assert.ok(['draft', 'ours'].includes(d.basis), `${d.title} has no basis`);
  }

  // The error-code choice is marked `ours`, not `draft`. The draft's usage text points at it and
  // its definition points away, and it is silent on what follows the browser leg — so it informs
  // the decision without settling it. Only the PKCE precondition is genuinely normative.
  const errorCode = DECISIONS.find((d) => /redirect_to_web with a request_uri/.test(d.title));
  assert.equal(errorCode.basis, 'ours');
  assert.equal(DECISIONS.find((d) => /No PKCE at initiate/.test(d.title)).basis, 'draft');
});

/* ── auth_session validation ────────────────────────────────────────────── */

test('a tampered auth_session is invalid_session, not invalid_grant', () => {
  const { state, first } = start('db-both', PWD_CAPS);

  const res = submit(state, 'action:identify:email:v1', {
    auth_session: 'spec-session-not-a-real-one',
    email: 'hazel.nutt@okta.com',
  });

  // The draft defines invalid_session for exactly this. The tenant returns invalid_grant, which
  // RFC 6749 defines for a bad authorization grant — an auth_session is not one.
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_session');

  // Rejected without advancing: the correct session still works afterwards.
  const ok = submit(state, 'action:identify:email:v1', {
    auth_session: first.body.auth_session,
    email: 'hazel.nutt@okta.com',
  });
  assert.equal(ok.status, 403);
});

test('an auth_session is single-use', () => {
  const { state, first } = start('db-both', PWD_CAPS);
  const firstSession = first.body.auth_session;

  const second = submit(state, 'action:identify:email:v1', {
    auth_session: firstSession,
    email: 'hazel.nutt@okta.com',
  });
  assert.notEqual(second.body.auth_session, firstSession, 'every response rotates the session');

  // Replaying the burned value is refused. The live tenant accepts it — which is what makes
  // challenge:email an OTP-bombing vector — so this is where spec mode and the tenant diverge.
  const replay = submit(state, 'action:verify:password:v1', {
    auth_session: firstSession,
    password: 'Abcd@1234',
  });
  assert.equal(replay.body.error, 'invalid_session');
  assert.equal(replay.gap, 'auth_session replay is not rejected');
});

test('a replayed session and an invented one are indistinguishable', () => {
  const { state, first } = start('db-both', PWD_CAPS);
  submit(state, 'action:identify:email:v1', {
    auth_session: first.body.auth_session,
    email: 'hazel.nutt@okta.com',
  });

  const replayed = submit(state, 'action:verify:password:v1', {
    auth_session: first.body.auth_session,
    password: 'Abcd@1234',
  });
  const invented = submit(state, 'action:verify:password:v1', {
    auth_session: 'spec-session-9999',
    password: 'Abcd@1234',
  });

  // Telling "expired" from "never existed" would confirm to an attacker that a guessed value had
  // once been real. The bodies must match; only the explanatory note differs.
  assert.deepEqual(replayed.body, invented.body);
});

test('the allow-list is only consulted for a session the server issued', () => {
  const { state, first } = start('db-both', PWD_CAPS);

  // An out-of-order action on a bogus session reports the session problem, not the refusal the
  // allow-list would produce — there is no allow-list to speak of without a valid session.
  const res = submit(state, 'action:verify:password:v1', {
    auth_session: 'spec-session-9999',
    password: 'Abcd@1234',
  });
  assert.equal(res.body.error, 'invalid_session');

  const outOfOrder = submit(state, 'action:verify:password:v1', {
    auth_session: first.body.auth_session,
    password: 'Abcd@1234',
  });
  assert.equal(outOfOrder.status, 400);
});

/* ── OTP resend: sign-in matches the signup PRD ─────────────────────────── */

const OTP_CAPS = ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'];

const challenged = () => {
  const { state } = start('db-email-otp', OTP_CAPS);
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  return { state, res: submit(state, 'action:challenge:email:v1', {}) };
};

test('the signup PRD always re-offers the challenge beside verify', () => {
  // The authority for the rule below. If a future extraction changes this, the sign-in engine
  // should change with it rather than quietly diverging again.
  let withVerify = 0;
  let alsoChallenge = 0;
  for (const scenario of SIGNUP_SCENARIOS) {
    for (const hp of scenario.happyPaths) {
      for (const ex of hp.exchanges) {
        const acts = (ex.response?.body?.next ?? []).map((n) => n.action);
        if (!acts.some((a) => a.startsWith('action:verify:otp'))) continue;
        withVerify += 1;
        if (acts.some((a) => a.startsWith('action:challenge:'))) alsoChallenge += 1;
      }
    }
  }
  assert.ok(withVerify > 0);
  assert.equal(alsoChallenge, withVerify, 'signup re-offers the challenge on every verify response');
});

test('sign-in re-offers the challenge so a code can be resent', () => {
  const { res } = challenged();

  // Previously this was verify-only: a user who never received the code had to restart the flow.
  assert.deepEqual(actions(res), ['action:verify:otp:v1', 'action:challenge:email:v1']);

  // Verify first, resend second — the reading order the PRD prints.
  assert.equal(res.body.next[0].action, 'action:verify:otp:v1');
});

test('the resend descriptor matches the shape it had on first offer', () => {
  const { state } = start('db-email-otp', OTP_CAPS);
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const firstOffer = state.next.find((n) => n.action === 'action:challenge:email:v1');
  const { res } = challenged();
  const resendOffer = entry(res, 'action:challenge:email:v1');

  // The PRD prints an identical descriptor either way — a resend is not a special shape, the
  // action simply stays on offer.
  assert.deepEqual(resendOffer, firstOffer);
  assert.equal(resendOffer.index, 0);
  assert.equal(resendOffer.identifier, 'haze******@okta****');
});

test('resending does not reset the wrong-code counter', () => {
  const { state } = challenged();

  submit(state, 'action:verify:otp:v1', { otp: '000000' });
  submit(state, 'action:verify:otp:v1', { otp: '000001' });
  assert.equal(state.attempts, 2);

  submit(state, 'action:challenge:email:v1', {});
  assert.equal(state.attempts, 2, 'a resend must not hand back attempts');

  // Otherwise the cap is unreachable: ask for a new code between guesses and brute force forever.
  for (const otp of ['000002', '000003']) submit(state, 'action:verify:otp:v1', { otp });
  const terminal = submit(state, 'action:verify:otp:v1', { otp: '000004' });
  assert.equal(terminal.body.error, 'access_denied');
  assert.equal(terminal.body.error_description, 'too_many_wrong_otp_attempts');
});

test('a resend issues a new ticket and counts itself', () => {
  const { state } = challenged();
  const first = state.pendingChallenge.ticketId;

  const res = submit(state, 'action:challenge:email:v1', {});
  assert.notEqual(state.pendingChallenge.ticketId, first, 'the previous code stops working');
  assert.equal(state.pendingChallenge.resends, 1);
  assert.match(res.note, /RESEND/);
});

test('only the outstanding channel is resendable', () => {
  // A pending email OTP must not reopen the phone challenge, and a pending push must not reopen
  // anything — the rule is per-channel, not "any challenge while any challenge is pending".
  const { state } = start('db-full', [
    'action:identify:email:v1',
    'action:challenge:email:v1',
    'action:challenge:phone:v1',
    'action:verify:otp:v1',
  ]);
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  const res = submit(state, 'action:challenge:email:v1', {});

  assert.equal(actions(res).includes('action:challenge:email:v1'), true);
  assert.equal(actions(res).includes('action:challenge:phone:v1'), false);
});

test('a decoy resend is indistinguishable from a real one', () => {
  const real = start('db-email-otp', OTP_CAPS);
  const decoy = start('db-email-otp', OTP_CAPS);
  submit(real.state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  submit(decoy.state, 'action:identify:email:v1', { email: 'nobody-xyz@example.com' });
  submit(real.state, 'action:challenge:email:v1', {});
  submit(decoy.state, 'action:challenge:email:v1', {});

  const a = submit(real.state, 'action:challenge:email:v1', {});
  const b = submit(decoy.state, 'action:challenge:email:v1', {});

  // Same status, same next, same masked identifier shape. Only the auth_session differs.
  assert.equal(a.status, b.status);
  assert.deepEqual(actions(a), actions(b));
  assert.equal(entry(a, 'action:verify:otp:v1').identifier.length > 0, true);
});

test('the simulator seeds a code it will actually accept', async () => {
  // The registry documents otp: '032252', a real code from the verified tenant walk. Seeding that
  // into spec mode handed the user a payload guaranteed to fail, with nothing on screen saying so.
  const scenario = SCENARIOS.find((s) => s.id === 'otp-happy');
  const t = simulatorTransport({ scenario });
  await t.start();
  await t.send({ action: 'action:identify:email:v1', email: 'hazel.nutt@okta.com' });
  const challenge = await t.send({ action: 'action:challenge:email:v1' });

  const verify = challenge.body.next.find((n) => n.action === 'action:verify:otp:v1');
  const seed = t.seedFor(verify);
  assert.notEqual(seed.otp, '032252', 'the live example must not be seeded into the simulator');

  const done = await t.send(seed);
  assert.equal(done.status, 200, `seeded otp ${seed.otp} was rejected`);

  // The registry keeps the real example — it is what live mode and the contract view should show.
  assert.equal(byId('action:verify:otp:v1').request[0].example, '032252');
});

test('a wrong code says what the simulator expects', async () => {
  const scenario = SCENARIOS.find((s) => s.id === 'otp-happy');
  const t = simulatorTransport({ scenario });
  await t.start();
  await t.send({ action: 'action:identify:email:v1', email: 'hazel.nutt@okta.com' });
  await t.send({ action: 'action:challenge:email:v1' });

  const wrong = await t.send({ action: 'action:verify:otp:v1', otp: '032252' });
  assert.equal(wrong.body.error_description, 'invalid_identifier_or_code');
  assert.match(wrong.note, /123456/);
  assert.match(wrong.note, /032252/);
});

/* ── what the console actually shows ────────────────────────────────────── */

test('the lockout scenario states its own rule, and the number is the real one', () => {
  const lockout = SCENARIOS.find((s) => s.id === 'otp-lockout');

  // The summary is the only place the rule is stated before you trip it, so it must not drift
  // from the constant the engine enforces.
  assert.match(lockout.summary, new RegExp(`\\b${MAX_OTP_ATTEMPTS}\\b`));
  assert.equal(lockout.script.filter((s) => s.action === 'action:verify:otp:v1').length, MAX_OTP_ATTEMPTS);
});

test('every login scenario carries a summary for the console to show', () => {
  for (const s of SCENARIOS) {
    assert.ok(s.summary?.length > 40, `${s.id} has no usable summary`);
  }
});

test('each response carries a note explaining what just happened', async () => {
  // Notes are the teaching layer and are now rendered under each exchange. A response without one
  // is a step the console cannot explain.
  for (const scenario of SCENARIOS) {
    for (const res of await driveLikeTheConsole(scenario)) {
      if (res.status === 200 || res.body?.error) {
        assert.ok(res.note?.length > 20, `${scenario.id}: a ${res.status} arrived with no note`);
      }
    }
  }
});

test('notes never leak internal document vocabulary into the console', async () => {
  // The console is deliberately free of PRD / milestone language; rendering notes must not
  // reintroduce it.
  const banned = /\b(PRD|Confluence|Milestone|M[1-5]|superseded|deliverable)\b/;
  for (const scenario of SCENARIOS) {
    for (const res of await driveLikeTheConsole(scenario)) {
      if (res.note) assert.doesNotMatch(res.note, banned, `${scenario.id}: ${res.note.slice(0, 90)}`);
    }
  }
});

test('error_description stays inside the documented vocabulary', async () => {
  // PWD pins the enum on insufficient_authorization to two values; D3 adds the polling and
  // recovery-code ones. Anything else is invented, which is how `invalid_password` got onto the
  // wire before. Free prose is allowed only on invalid_request, where RFC 6749 actually wants it.
  const CODED = new Set([
    'invalid_identifier_or_code',
    'invalid_identifier_or_password',
    'slow_down',
    'authorization_pending',
    'invalid_code',
    'too_many_wrong_otp_attempts',
    'no_eligible_factors',
    'authorization_rejected',
    'challenge_expired',
  ]);

  for (const scenario of SCENARIOS) {
    for (const res of await driveLikeTheConsole(scenario)) {
      const { error, error_description: desc } = res.body ?? {};
      if (!desc) continue;
      if (error !== 'insufficient_authorization' && error !== 'access_denied') continue;
      assert.ok(CODED.has(desc), `${scenario.id}: undocumented error_description "${desc}"`);
    }
  }
});

test('a dependency outage is distinguishable from a wrong credential', () => {
  // PWD's one carve-out from the uniform failure. A client that cannot tell these apart re-prompts
  // the user and retries into an outage, which is exactly what the rule exists to prevent.
  const { state } = start('db-both', PWD_CAPS);
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const outage = submit(state, 'action:verify:password:v1', {
    password: 'Abcd@1234',
    simulate: 'upstream_error',
  });
  assert.equal(outage.status, 500);
  assert.equal(outage.body.error, 'server_error');
  assert.equal(outage.body.error_description, 'An unexpected error occurred.');

  // Masked: it names no dependency and leaks nothing about the credential.
  assert.equal(outage.body.next, undefined);
  assert.equal(outage.body.auth_session, undefined, 'nothing was consumed, so nothing rotates');

  // And the session survives — the same call works once the dependency recovers.
  const recovered = submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  assert.equal(recovered.status, 200);
});

test('the outage response shares no shape with the credential failure', () => {
  const a = start('db-both', PWD_CAPS);
  const b = start('db-both', PWD_CAPS);
  submit(a.state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  submit(b.state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });

  const wrong = submit(a.state, 'action:verify:password:v1', { password: 'nope' });
  const outage = submit(b.state, 'action:verify:password:v1', {
    password: 'nope',
    simulate: 'upstream_error',
  });

  assert.notEqual(wrong.status, outage.status);
  assert.notEqual(wrong.body.error, outage.body.error);
  assert.ok(wrong.body.next, 'a credential failure is recoverable and re-offers the methods');
  assert.equal(outage.body.next, undefined, 'an outage offers nothing to retry against');
});

/* ── the masked and the distinguishable ─────────────────────────────────── */

test('every Attack Protection outcome is byte-identical to a typo', () => {
  // PWD Decision 4 collapses six negative outcomes into one response because each of the specific
  // ones is a true statement about an account that exists. If any of these diverged by a single
  // byte, that collapse would be decorative.
  const failure = (simulate) => {
    const { state } = start('db-both', PWD_CAPS);
    submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
    const res = submit(state, 'action:verify:password:v1', {
      password: simulate ? 'Abcd@1234' : 'wrong-one',
      ...(simulate ? { simulate } : {}),
    });
    // auth_session rotates every response, so normalise it before comparing.
    return { status: res.status, body: { ...res.body, auth_session: null } };
  };

  const typo = failure(null);
  for (const outcome of ['user_blocked', 'ip_blocked', 'password_breached', 'same_user_login']) {
    assert.deepEqual(failure(outcome), typo, `${outcome} is distinguishable from a wrong password`);
  }
});

test('a malformed request keeps the session and restates the allow-list', () => {
  const { state, first } = start('db-email-otp', OTP_CAPS);

  const missing = submit(state, 'action:identify:email:v1', { email: '' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'invalid_request');
  assert.deepEqual(missing.body.next, first.body.next, 'the allow-list still stands');
  assert.ok(missing.body.auth_session, 'the draft expects the session back on the error response');

  // Prose, not a coded value — the one place RFC 6749's definition is actually followed.
  assert.match(missing.body.error_description, /Missing "email"/);

  // And the corrected call goes through.
  assert.equal(submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' }).status, 403);
});

test('push denial and push expiry are terminal but not interchangeable', () => {
  const drive = (simulate) => {
    const { state } = start('db-both', [
      'action:identify:email:v1',
      'action:verify:password:v1',
      'action:challenge:push:v1',
      'action:verify:oob:v1',
    ], { mfaPolicy: 'Always' });
    submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
    submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
    submit(state, 'action:challenge:push:v1', { index: 0 });
    return submit(state, 'action:verify:oob:v1', { simulate });
  };

  const denied = drive('rejected');
  const expired = drive('expired');

  for (const res of [denied, expired]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'access_denied');
    assert.equal(res.body.next, undefined, 'terminal: nothing to continue on');
    assert.equal(res.body.auth_session, undefined);
  }

  // Same status, same error — only the description separates them, and the correct client
  // response is opposite: never re-challenge a denial, always re-challenge an expiry.
  assert.equal(denied.body.error_description, 'authorization_rejected');
  assert.equal(expired.body.error_description, 'challenge_expired');
});

test('a recovery code is rejected with its own code, not the credential pair', () => {
  const { state } = start('db-both', [
    'action:identify:email:v1',
    'action:verify:password:v1',
    'action:challenge:recovery-code:v1',
    'action:verify:recovery-code:v1',
  ], { mfaPolicy: 'Always' });
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  submit(state, 'action:verify:password:v1', { password: 'Abcd@1234' });
  submit(state, 'action:challenge:recovery-code:v1', {});

  const short = submit(state, 'action:verify:recovery-code:v1', { recovery_code: 'SHORT' });
  assert.equal(short.body.error_description, 'invalid_code');
  assert.ok(short.body.next, 'recoverable');

  const done = submit(state, 'action:verify:recovery-code:v1', { recovery_code: 'ABCD1234EFGH5678' });
  assert.equal(done.status, 200);
});

/* ── the picker tells the truth about the flows ─────────────────────────── */

test('`browser: true` matches what the flow actually does', async () => {
  // The picker claims "Needs a browser", which is the question that decides whether an integration
  // needs a WebView at all. It is hand-declared on the scenario, so it is checked against the only
  // thing that can settle it: whether any response came back redirect_to_web.
  for (const scenario of SCENARIOS) {
    const trail = await driveLikeTheConsole(scenario);
    const handedOff = trail.some((r) => r.body?.error === 'redirect_to_web');
    assert.equal(
      scenario.browser === true,
      handedOff,
      `${scenario.id}: declared browser=${scenario.browser === true}, actually handed off=${handedOff}`
    );
  }
});

test('the native paths are not counted as needing a browser', () => {
  // Both pause the pipeline and both are easy to mistake for a handoff. Neither opens anything.
  for (const id of ['native-social', 'post-login-form-native']) {
    const s = SCENARIOS.find((x) => x.id === id);
    assert.notEqual(s.browser, true, `${id} renders in-app`);
  }
});

test('every sign-in flow is under Sign in, errors included', async () => {
  const { ALL_FLOWS, matchesFilter } = await import('../src/data/flows.js');

  // The previous scheme lost any scenario tagged only as an error: it was in neither Sign in nor
  // Sign up, so a sign-in error had no journey at all.
  const signIn = ALL_FLOWS.filter((f) => matchesFilter(f, 'login'));
  const signUp = ALL_FLOWS.filter((f) => matchesFilter(f, 'signup'));
  assert.equal(signIn.length + signUp.length, ALL_FLOWS.length, 'every flow has exactly one journey');

  for (const id of ['login:session-replay', 'login:out-of-order', 'login:missing-field']) {
    assert.ok(signIn.some((f) => f.id === id), `${id} is a sign-in flow`);
  }
});

test('a second row appears only where it answers something', async () => {
  const { ALL_FLOWS, FLOW_FILTERS, matchesFilter, facetsFor } = await import('../src/data/flows.js');

  const rows = Object.fromEntries(
    FLOW_FILTERS.map((f) => [f.id, facetsFor(f.id, ALL_FLOWS.filter((x) => matchesFilter(x, f.id)))])
  );

  // "All" spans two journeys with nothing in common to ask about.
  assert.equal(rows.all, null);

  // Present where the chip raises an obvious follow-up.
  assert.equal(rows.signup.label, 'Password');
  assert.equal(rows.login.label, 'Covers');
  // Thirty flows is the longest list in the picker, so this is the row that matters most.
  assert.ok(rows.login.items.length >= 6, 'sign in needs a real breakdown');
  assert.equal(rows.errors.label, 'Recovery');
  assert.deepEqual(rows.errors.items.map((i) => i.label).sort(), ['Recoverable', 'Terminal']);
  assert.equal(rows.browser.label, 'Web leg');

  // And every row genuinely narrows — a single option is not a filter.
  for (const [id, row] of Object.entries(rows)) {
    if (row) assert.ok(row.items.length >= 2, `${id} offers a one-option second row`);
  }
});

/* ── the request pane shows only wire fields ────────────────────────────── */

test('`simulate` never appears in a request the user is shown', async () => {
  // It is an internal hook for driving denials, expiries and abandoned browser legs — no client
  // ever sends it. Seeding it into the request pane would put a field in the contract that does
  // not exist, so the transport applies it from the script instead.
  for (const scenario of SCENARIOS) {
    const t = simulatorTransport({ scenario });
    let res = await t.start();

    for (let i = 1; i < (scenario.script ?? []).length; i++) {
      const offered = res.body?.next ?? [];
      if (!offered.length) break;
      const wanted = scenario.script[i].action;
      const entryFor = offered.find((n) => n.action === wanted) ?? { action: wanted };

      const seed = t.seedFor(entryFor);
      assert.equal(seed.simulate, undefined, `${scenario.id} step ${i} seeds simulate`);

      if (entryFor.poll_in_ms) await new Promise((r) => setTimeout(r, entryFor.poll_in_ms + 50));
      res = await t.send(seed);
      assert.equal(res.request.body.simulate, undefined, `${scenario.id} step ${i} displays simulate`);
    }
  }
});

test('the scenarios that rely on simulate still do what they claim', async () => {
  // The corollary: dropping it from the request must not quietly disable the behaviour.
  for (const id of ['federated-abandoned', 'mfa-push-denied', 'mfa-push-expired', 'upstream-outage']) {
    const scenario = SCENARIOS.find((s) => s.id === id);
    const trail = await driveLikeTheConsole(scenario);
    assert.ok(
      OUTCOMES[scenario.expect](trail.at(-1)),
      `${id} no longer reaches ${scenario.expect} once simulate is out of the request`
    );
  }
});

test('a browser leg explains itself between the calls', async () => {
  // The gap this fills: an href, then a resume that succeeds for no visible reason. Every response
  // that hands off must carry the description of what happens out there.
  for (const scenario of SCENARIOS) {
    for (const res of await driveLikeTheConsole(scenario)) {
      if (res.body?.error !== 'redirect_to_web') {
        assert.equal(res.handoff, undefined, `${scenario.id}: handoff on a non-handoff response`);
        continue;
      }
      const h = res.handoff;
      assert.ok(h, `${scenario.id}: handed off with no explanation of the browser leg`);
      assert.ok(h.title && h.opens && h.callback && h.resume, `${scenario.id}: incomplete handoff`);
      assert.ok(h.steps.length >= 2, `${scenario.id}: handoff has no steps`);

      // The invariant the whole pattern rests on, stated where the user meets it.
      assert.match(h.callback, /^myapp:\/\//);
      assert.equal(h.resume, res.body.next[0].action, 'resume on the action that was offered');
    }
  }
});

test('a browser leg never claims an outcome it cannot know', async () => {
  // The bug this replaces: the interstitial after the opening call narrated a SUCCESSFUL leg —
  // "the user authenticates… the record is COMPLETE" — and the very next response explained that
  // the user had closed the browser. The opening response cannot know; only the resume can say.
  for (const scenario of SCENARIOS) {
    const trail = await driveLikeTheConsole(scenario);

    for (const [i, res] of trail.entries()) {
      if (res.handoff) {
        // Nothing in the description of an open leg may assert how it ended.
        const text = [res.handoff.opens, ...res.handoff.steps].join(' ');
        assert.doesNotMatch(text, /COMPLETE\b|completed|solved/i, `${scenario.id} step ${i}`);
      }
      // An outcome only ever rides on a call that resumes a leg the previous call opened.
      if (res.legOutcome) {
        assert.ok(trail[i - 1]?.handoff, `${scenario.id} step ${i}: outcome with no leg before it`);
        assert.ok(['completed', 'abandoned'].includes(res.legOutcome.state));
        assert.ok(res.legOutcome.detail?.length > 20);
      }
    }
  }
});

test('the abandoned scenario reports the leg as not completed, then completed', async () => {
  const trail = await driveLikeTheConsole(SCENARIOS.find((s) => s.id === 'federated-abandoned'));

  assert.ok(trail[0].handoff, 'call 1 opens a leg');
  assert.equal(trail[0].legOutcome, undefined, 'call 1 cannot know how it went');

  // Call 2 is the resume that finds it abandoned — and reopens a leg of its own.
  assert.equal(trail[1].legOutcome.state, 'abandoned');
  assert.ok(trail[1].handoff, 'and hands back a fresh reference');

  // Call 3 resumes the second leg, which did complete.
  assert.equal(trail[2].legOutcome.state, 'completed');
  assert.equal(trail[2].status, 200);
});

test('every completed leg says what the server did with the result', async () => {
  for (const scenario of SCENARIOS) {
    for (const res of await driveLikeTheConsole(scenario)) {
      if (res.legOutcome?.state !== 'completed') continue;
      // The point of the pattern: the artifact never reached the client.
      assert.match(res.legOutcome.detail, /token vault|SOLVED|COMPLETED|advanced the session/);
    }
  }
});
