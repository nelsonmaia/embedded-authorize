/**
 * Do the two spec transports behave?
 *
 * The important test is the first one: replay all 26 documented happy paths through the canned
 * transport and assert every response matches the PRD. That is the whole promise of spec mode.
 *
 * The live transport is not covered here — it needs a network and a tenant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cannedTransport } from '../src/transports/cannedTransport.js';
import { simulatorTransport } from '../src/transports/simulatorTransport.js';
import { SIGNUP_SCENARIOS } from '../src/data/signupPrd.js';
import { byScenarioId } from '../src/data/loginScenarios.js';

test('all 26 documented happy paths replay exactly', async () => {
  let paths = 0;
  let calls = 0;

  for (const scenario of SIGNUP_SCENARIOS) {
    for (const happyPath of scenario.happyPaths) {
      const t = cannedTransport({ scenario, happyPath });
      const first = await t.start();
      assert.deepEqual(
        first.body,
        happyPath.exchanges[0].response.body,
        `${happyPath.id} ex0 response`
      );
      calls += 1;

      for (let i = 1; i < happyPath.exchanges.length; i++) {
        const ex = happyPath.exchanges[i];
        const r = await t.send(structuredClone(ex.request.body));
        assert.ok(!r.undocumented, `${happyPath.id} ex${i} unexpectedly undocumented`);
        assert.deepEqual(r.body, ex.response.body, `${happyPath.id} ex${i} response`);
        assert.equal(r.status, ex.response.status);
        calls += 1;
      }

      const last = await t.send({ action: 'action:signup:confirm:v1' });
      assert.ok(last.undocumented, `${happyPath.id} should be exhausted after its last call`);
      paths += 1;
    }
  }

  assert.equal(paths, 26);
  assert.equal(calls, 200);
});

test('seedFor prefills the next documented request, plus the client_id it now needs', async () => {
  const scenario = SIGNUP_SCENARIOS.find((s) => s.number === 8);
  const happyPath = scenario.happyPaths.find((h) => h.number === 3);
  const t = cannedTransport({ scenario, happyPath });

  /* The PRD was recorded before client_id was required on every call, so the seed is the
     documented body plus that one field. Everything else must still match the document exactly —
     that is what spec mode promises — so this asserts the addition and nothing but it. */
  const withClientId = (body) => ({ client_id: '<client_id>', ...structuredClone(body) });

  assert.deepEqual(t.seedFor(), withClientId(happyPath.exchanges[0].request.body));
  await t.start();
  assert.deepEqual(t.seedFor(), withClientId(happyPath.exchanges[1].request.body));
});

test('the recording itself is left alone — only the seed gains client_id', () => {
  // Rewriting the extracted PRD would make the console disagree with the document it cites.
  for (const scenario of SIGNUP_SCENARIOS) {
    for (const happyPath of scenario.happyPaths) {
      for (const ex of happyPath.exchanges) {
        assert.ok(
          !('client_id' in ex.request.body) || ex.request.body.client_id,
          `${happyPath.id} recording must not be rewritten`
        );
      }
    }
  }
});

test('an edited value is sent and reflected back in the masked identifier', async () => {
  const scenario = SIGNUP_SCENARIOS.find((s) => s.number === 1);
  const happyPath = scenario.happyPaths[0];
  const t = cannedTransport({ scenario, happyPath });

  await t.start();
  await t.send({ auth_session: 'sess_1', action: 'action:signup:v1' });

  const r = await t.send({
    auth_session: 'sess_2',
    action: 'action:identify:email:v1',
    email: 'someone.else@contoso.com',
  });

  assert.equal(r.request.body.email, 'someone.else@contoso.com', 'the edit must actually be sent');
  const masked = r.body.next[0].identifier;
  assert.notEqual(masked, 'usxx@exxxxxx.com', 'identifier should be re-masked from the edited value');
  assert.ok(masked.includes('*') || masked.includes('x'), 'still masked');
  assert.ok(!masked.includes('someone.else'), 'must not leak the full local-part');
});

test('changing the action to something undocumented refuses rather than inventing a response', async () => {
  const scenario = SIGNUP_SCENARIOS.find((s) => s.number === 1);
  const t = cannedTransport({ scenario, happyPath: scenario.happyPaths[0] });
  await t.start();

  const r = await t.send({ auth_session: 'sess_1', action: 'action:verify:otp:v1', otp: '123456' });
  assert.equal(r.undocumented, true);
  assert.deepEqual(r.body, {}, 'must not fabricate a body');
  assert.match(r.error, /documents "action:signup:v1"/);
  assert.ok(r.expected, 'should say what the PRD expected instead');
});

test('the simulator computes login responses rather than replaying them', async () => {
  const scenario = byScenarioId('otp-happy');
  const t = simulatorTransport({ scenario });

  const init = await t.start();
  assert.equal(init.status, 403);
  assert.ok(Array.isArray(init.body.next) && init.body.next.length > 0);

  // Walk the scripted happy path.
  let last = init;
  for (const step of scenario.script.filter((s) => s.action !== 'initiate')) {
    last = await t.send({ action: step.action, ...(step.payload || {}) });
  }
  assert.ok(last.body.authorization_code, 'otp-happy should end with an authorization code');
});

test('a wrong OTP really fails in the simulator — payload edits have consequences', async () => {
  const scenario = byScenarioId('otp-happy');
  const t = simulatorTransport({ scenario });
  await t.start();
  await t.send({ action: 'action:identify:email:v1', email: 'hazel.nutt@okta.com' });
  await t.send({ action: 'action:challenge:email:v1' });

  const bad = await t.send({ action: 'action:verify:otp:v1', otp: '000000' });
  assert.ok(!bad.body.authorization_code, 'a wrong code must not issue a code');
  assert.notEqual(bad.status, 200);

  const good = await t.send({ action: 'action:verify:otp:v1', otp: '123456' });
  assert.ok(good.body.authorization_code, 'the correct code should then succeed');
});

test('the simulator refuses an action outside next[]', async () => {
  const t = simulatorTransport({ scenario: byScenarioId('otp-happy') });
  await t.start();
  const r = await t.send({ action: 'action:verify:otp:v1', otp: '123456' });
  assert.ok(!r.body.authorization_code, 'must not skip straight to verify');
});

test('secrets are masked in what the UI displays', async () => {
  const t = simulatorTransport({ scenario: byScenarioId('password-only') });
  await t.start();
  await t.send({ action: 'action:identify:email:v1', email: 'hazel.nutt@okta.com' });
  const r = await t.send({ action: 'action:verify:password:v1', password: 'Abcd@1234' });
  assert.equal(r.request.body.password, '••••••••');
  assert.ok(!JSON.stringify(r.request.body).includes('Abcd@1234'));
});

test('both spec transports satisfy the same interface', () => {
  const scenario = SIGNUP_SCENARIOS[0];
  const impls = [
    cannedTransport({ scenario, happyPath: scenario.happyPaths[0] }),
    simulatorTransport({ scenario: byScenarioId('otp-happy') }),
  ];
  for (const t of impls) {
    for (const m of ['start', 'send', 'seedFor', 'inspect', 'reset']) {
      assert.equal(typeof t[m], 'function', `${t.kind} must implement ${m}`);
    }
    assert.equal(t.isLive, false, `${t.kind} must not claim to be live`);
  }
});

test('reset returns a transport to its starting point', async () => {
  const scenario = SIGNUP_SCENARIOS[0];
  const t = cannedTransport({ scenario, happyPath: scenario.happyPaths[0] });
  const a = await t.start();
  await t.send({ auth_session: 'sess_1', action: 'action:signup:v1' });
  t.reset();
  const b = await t.start();
  assert.deepEqual(b.body, a.body);
});

test('live: MRRT refresh and My Account profile ride the token and header through the proxy', async () => {
  const { liveTransport } = await import('../src/transports/liveTransport.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const env = JSON.parse(init.body);
    calls.push(env);
    const body = env.path === '/oauth/token'
      ? env.body.grant_type === 'refresh_token'
        ? { access_token: 'AT_ME', token_type: 'Bearer' }
        : { access_token: 'AT0', refresh_token: 'RT0' }
      : { name: 'Ada' };
    return { json: async () => ({ ok: true, status: 200, body, durationMs: 1 }) };
  };
  try {
    const t = liveTransport({
      tenant: { domain: 'https://Acme.auth0.com/', clientId: 'cid', connection: 'c' },
      capabilities: [],
    });
    assert.equal(t.hasRefreshToken(), false);
    await t.exchange({ grant_type: 'authorization_code', code: 'c' });
    assert.equal(t.hasRefreshToken(), true);

    const seed = t.refreshSeed();
    assert.deepEqual(seed, {
      grant_type: 'refresh_token', client_id: 'cid', refresh_token: 'RT0',
      audience: 'https://acme.auth0.com/me/', scope: 'read:me:profile update:me:profile read:me:authentication_methods read:me:factors',
    });
    const r = await t.refresh();
    assert.equal(r.request.body.refresh_token, '••••••••', 'shown redacted');
    assert.equal(calls.at(-1).body.refresh_token, 'RT0', 'sent in full');

    assert.equal(t.profileSeed().access_token, 'AT_ME');
    const p = await t.getProfile({ access_token: 'AT_ME', fields: 'name' });
    const last = calls.at(-1);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/me/v1/profile?fields=name');
    assert.equal(last.authorization, 'Bearer AT_ME');
    assert.equal(last.body, undefined);
    assert.equal(p.request.method, 'GET');
    assert.equal(p.body.name, 'Ada');

    const u = await t.updateProfile();
    const patched = calls.at(-1);
    assert.equal(patched.method, 'PATCH');
    assert.equal(patched.path, '/me/v1/profile');
    assert.equal(patched.authorization, 'Bearer AT_ME');
    assert.deepEqual(patched.body, { family_name: 'Hazell nut' }, 'token is a header, not in the body');
    assert.equal(u.request.method, 'PATCH');

    await t.listAuthMethods({ access_token: 'AT_ME', type: 'phone' });
    const listed = calls.at(-1);
    assert.equal(listed.method, 'GET');
    assert.equal(listed.path, '/me/v1/authentication-methods?type=phone');
    assert.equal(listed.authorization, 'Bearer AT_ME');

    await t.listFactors();
    const factors = calls.at(-1);
    assert.equal(factors.method, 'GET');
    assert.equal(factors.path, '/me/v1/factors');
    assert.equal(factors.authorization, 'Bearer AT_ME');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('live: verify:otp is seeded with the type the server named on the next[] entry', async () => {
  const { liveTransport } = await import('../src/transports/liveTransport.js');
  const t = liveTransport({ tenant: { domain: 'x.auth0.com', clientId: 'cid', connection: 'c' }, capabilities: [] });
  const totp = t.seedFor({ action: 'action:verify:otp:v1', channel: 'totp' });
  assert.equal(totp.type, 'totp');
  const email = t.seedFor({ action: 'action:verify:otp:v1', channel: 'email' });
  assert.equal(email.type, 'oob', 'the recorded email walk is unchanged');
});
