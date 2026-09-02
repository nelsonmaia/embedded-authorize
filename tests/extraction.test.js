/**
 * Is the extracted PRD data faithful to the source page?
 *
 *   node --test tests/
 *
 * The generator already asserts internally and refuses to write on failure. These tests re-check
 * the committed artefact, so a hand-edit to signupPrd.generated.json is caught too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, '../src/data/signupPrd.generated.json'), 'utf8'));
const source = readFileSync(join(here, '../src/data/sources/signup-prd-1068894784.md'), 'utf8');

const allExchanges = data.scenarios.flatMap((s) =>
  s.happyPaths.flatMap((hp) => hp.exchanges.map((x) => ({ ...x, hpId: hp.id })))
);

test('generated data came from this exact source file', () => {
  const sha = createHash('sha256').update(source).digest('hex');
  assert.equal(
    data.meta.sourceSha256,
    sha,
    'source file changed since generation — re-run `npm run extract`'
  );
});

test('counts match the verified shape of the PRD', () => {
  assert.equal(data.scenarios.length, 15);
  assert.equal(data.scenarios.reduce((n, s) => n + s.happyPaths.length, 0), 26);
  assert.equal(allExchanges.length, 200);
});

test('every exchange round-trips structurally against its raw fence', () => {
  for (const x of allExchanges) {
    // Structural, not textual: the PRD writes next[] entries inline while JSON.stringify
    // expands them, so a byte comparison would test a formatting convention, not fidelity.
    const req = JSON.parse(x.raw.request.split('\n').slice(1).join('\n'));
    const res = JSON.parse(x.raw.response);
    assert.deepEqual(req, x.request.body, `${x.hpId} ex${x.index} request`);
    assert.deepEqual(res, x.response.body, `${x.hpId} ex${x.index} response`);
    assert.deepEqual(JSON.parse(JSON.stringify(x.request.body)), x.request.body);
  }
});

test('every raw request fence is a POST to /e/authorize', () => {
  for (const x of allExchanges) {
    assert.equal(x.raw.request.split('\n')[0].trim(), 'POST /e/authorize', x.hpId);
    assert.equal(x.request.path, '/e/authorize');
  }
});

test('auth_session chains correctly through each happy path', () => {
  for (const s of data.scenarios) {
    for (const hp of s.happyPaths) {
      hp.exchanges.forEach((x, i) => {
        if (i === 0) {
          assert.equal(x.sessionIn, null, `${hp.id} ex0 must not send auth_session`);
          assert.ok(x.request.body.client_id, `${hp.id} ex0 must send client_id`);
        } else {
          assert.equal(
            x.sessionIn,
            hp.exchanges[i - 1].sessionOut,
            `${hp.id} ex${i} session continuity`
          );
        }
      });
      const last = hp.exchanges.at(-1);
      assert.ok(last.response.body.authorization_code, `${hp.id} must end with a code`);
      assert.equal(last.response.body.next, undefined, `${hp.id} final response must have no next[]`);
    }
  }
});

test('every non-final response is a continuation, not a failure', () => {
  for (const s of data.scenarios) {
    for (const hp of s.happyPaths) {
      hp.exchanges.slice(0, -1).forEach((x, i) => {
        assert.equal(x.response.body.error, 'insufficient_authorization', `${hp.id} ex${i}`);
        assert.equal(x.response.status, 403);
        assert.ok(Array.isArray(x.response.body.next), `${hp.id} ex${i} must carry next[]`);
      });
    }
  }
});

test('the PRD never sends an action its previous next[] did not offer', () => {
  // This tests the document, not the parser. A failure here is a PRD bug worth filing.
  const violations = [];
  for (const s of data.scenarios) {
    for (const hp of s.happyPaths) {
      hp.exchanges.forEach((x, i) => {
        if (i === 0) return;
        const a = x.request.body.action;
        if (a && !x.allowedIn.includes(a)) violations.push(`${hp.id} ex${i}: ${a} ∉ [${x.allowedIn}]`);
      });
    }
  }
  assert.deepEqual(violations, []);
});

test('every step has a human label, 1:1 with the numbered prose list', () => {
  for (const s of data.scenarios) {
    for (const hp of s.happyPaths) {
      assert.equal(hp.stepLabels.length, hp.exchanges.length, hp.id);
      for (const x of hp.exchanges) assert.ok(x.label, `${hp.id} ex${x.index} has no label`);
    }
  }
});

test('milestones partition scenarios 1..15 exactly once', () => {
  const covered = data.milestones.flatMap((m) => m.scenarioNumbers).sort((a, b) => a - b);
  assert.deepEqual(covered, Array.from({ length: 15 }, (_, i) => i + 1));
});

test('derived catalogues are consistent with the exchanges', () => {
  const sends = new Map();
  for (const x of allExchanges) {
    const a = x.request.body.action;
    if (a) sends.set(a, (sends.get(a) || 0) + 1);
  }
  for (const entry of data.derived.actionCatalog) {
    if (sends.has(entry.action)) assert.equal(entry.sends, sends.get(entry.action), entry.action);
  }
  const totalNext = allExchanges.reduce((n, x) => n + (x.response.body.next?.length || 0), 0);
  const shapeSum = data.derived.nextShapes.reduce((n, s) => n + s.occurrences, 0);
  assert.equal(shapeSum, totalNext, 'next-shape occurrences must account for every next[] entry');
});

test('statuses are flagged as derived, because the PRD states none', () => {
  assert.equal(data.meta.statusDerived, true);
  for (const x of allExchanges) assert.equal(x.response.statusDerived, true);
  // And the source genuinely has no status lines to have read.
  assert.equal(/^HTTP\/\d/m.test(source), false);
});
