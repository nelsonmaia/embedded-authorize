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

test('seedFor prefills the next documented request', async () => {
  const scenario = SIGNUP_SCENARIOS.find((s) => s.number === 8);
  const happyPath = scenario.happyPaths.find((h) => h.number === 3);
  const t = cannedTransport({ scenario, happyPath });

  assert.deepEqual(t.seedFor(), happyPath.exchanges[0].request.body);
  await t.start();
  assert.deepEqual(t.seedFor(), happyPath.exchanges[1].request.body);
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
