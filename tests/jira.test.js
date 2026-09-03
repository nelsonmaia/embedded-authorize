/**
 * The Jira ticket body and the deep-link fallback.
 *
 * The credential path is not covered here — it needs a Jira. What is covered is everything that
 * decides whether a ticket is useful when someone opens it a week later, and the one property that
 * matters most: the same text goes into the API call and into the URL, so a ticket does not read
 * differently depending on how it was raised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ticketFor, createIssueUrl } from '../src/data/jiraTicket.js';
import { checkResponse } from '../src/data/conformance.js';

const FINDING = {
  severity: 'gap',
  title: 'next[] is missing action:challenge:email:v1',
  expected: '["action:verify:otp:v1","action:challenge:email:v1"]',
  actual: '["action:verify:otp:v1"]',
  why: 'A code is outstanding, so the challenge stays on offer for a resend.',
  gap: 'The challenge is withdrawn once its own code is outstanding',
};

const EXCHANGE = {
  request: { method: 'POST', path: '/e/authorize', body: { auth_session: 'abc', action: 'action:challenge:email:v1' } },
  status: 403,
  body: { error: 'insufficient_authorization', auth_session: 'def', next: [{ action: 'action:verify:otp:v1' }] },
};

test('the ticket carries the difference, the reason and the evidence', () => {
  const t = ticketFor({ finding: FINDING, exchange: EXCHANGE, tenant: 'x.auth0.com', observedOn: '2026-09-03' });

  assert.equal(t.summary, FINDING.title, 'the summary is the finding, not a category');
  for (const fragment of [FINDING.expected, FINDING.actual, FINDING.why, 'x.auth0.com', '2026-09-03']) {
    assert.ok(t.description.includes(fragment), `missing: ${fragment}`);
  }
  // Someone reading it a week later needs the call that produced it.
  assert.ok(t.description.includes('POST /e/authorize'));
  assert.ok(t.description.includes('HTTP 403'));
  assert.ok(t.description.includes('{code:json}'), 'the exchange is fenced, not inline prose');
});

test('a recorded gap says so, so it is not mistaken for a discovery', () => {
  const t = ticketFor({ finding: FINDING });
  assert.ok(t.description.includes(FINDING.gap));
  assert.match(t.description, /not because it is news/);

  const fresh = ticketFor({ finding: { ...FINDING, gap: undefined } });
  assert.ok(!fresh.description.includes('Already recorded'));
});

test('severity becomes a label a board can filter on', () => {
  assert.ok(ticketFor({ finding: FINDING }).labels.includes('known-gap'));
  assert.ok(ticketFor({ finding: { ...FINDING, severity: 'violation' } }).labels.includes('off-spec'));
  assert.ok(ticketFor({ finding: { ...FINDING, severity: 'undocumented' } }).labels.includes('undocumented'));
  // And every ticket is findable as one of ours.
  assert.ok(ticketFor({ finding: FINDING }).labels.includes('embedded-authorize'));
});

test('a session token does not fill the ticket', () => {
  // auth_session is 3 KB of base64 nobody reads, and it would push the real content out of view.
  const huge = { ...EXCHANGE, body: { ...EXCHANGE.body, auth_session: 'A'.repeat(4000) } };
  const t = ticketFor({ finding: FINDING, exchange: huge });

  assert.ok(t.description.length < 4000, `${t.description.length} characters`);
  assert.match(t.description, /truncated, \d+ more characters/);
});

test('nothing is invented when there is nothing to describe', () => {
  assert.equal(ticketFor({}), null);
  assert.equal(ticketFor(), null);
  const minimal = ticketFor({ finding: { severity: 'gap', title: 'x', why: 'y' } });
  assert.ok(minimal.description.includes('y'));
  assert.ok(!minimal.description.includes('The exchange'), 'no empty evidence section');
});

/* ── the deep-link fallback ─────────────────────────────────────────────── */

test('the create-issue URL prefills the same text', () => {
  const ticket = ticketFor({ finding: FINDING, tenant: 'x.auth0.com' });
  const url = createIssueUrl({ site: 'acme', projectId: '10001', issueTypeId: '10004', ticket });

  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://acme.atlassian.net');
  assert.equal(parsed.pathname, '/secure/CreateIssueDetails!init.jspa');
  assert.equal(parsed.searchParams.get('pid'), '10001');
  assert.equal(parsed.searchParams.get('issuetype'), '10004');
  assert.equal(parsed.searchParams.get('summary'), ticket.summary);
  assert.ok(parsed.searchParams.get('description').includes(FINDING.expected));
});

test('a full host is accepted as well as a site name', () => {
  const ticket = ticketFor({ finding: FINDING });
  assert.match(createIssueUrl({ site: 'acme.atlassian.net', projectId: '1', ticket }), /^https:\/\/acme\.atlassian\.net\//);
});

test('without a numeric project id there is no link at all', () => {
  // CreateIssueDetails!init.jspa will not resolve a project KEY, and a link that silently drops
  // the prefill is worse than falling back to the clipboard.
  const ticket = ticketFor({ finding: FINDING });
  assert.equal(createIssueUrl({ site: 'acme', ticket }), null);
  assert.equal(createIssueUrl({ projectId: '1', ticket }), null);
  assert.equal(createIssueUrl({ site: 'acme', projectId: '1' }), null);
});

test('a long description is trimmed to fit the URL, and says so', () => {
  const ticket = ticketFor({ finding: FINDING, exchange: EXCHANGE, tenant: 'x.auth0.com' });
  ticket.description += '\n'.padEnd(3000, 'z');

  const description = new URL(createIssueUrl({ site: 'acme', projectId: '1', ticket })).searchParams.get('description');
  assert.ok(description.length < ticket.description.length);
  assert.match(description, /full text is on your clipboard/);
});

test('a real finding survives the whole path', () => {
  // End to end over the actual checker output rather than a hand-written finding.
  const [finding] = checkResponse({
    request: { body: { client_id: 'x', capabilities: ['action:identify:email:v1'] } },
    status: 403,
    body: { error: 'insufficient_authorization', auth_session: 'a', next: [{ action: 'action:identify:email:v1' }] },
  });
  assert.ok(finding, 'the no-PKCE finding should still fire');

  const ticket = ticketFor({ finding, tenant: 'nelson.jp.auth0.com', observedOn: '2026-09-03' });
  assert.ok(ticket.summary.length > 10);
  assert.ok(ticket.description.includes('public clients'));
  assert.ok(createIssueUrl({ site: 'acme', projectId: '1', ticket }).length > 200);
});

/* ── the credential stays out of the browser ────────────────────────────── */

test('the middleware is dev-only and never returns the token', () => {
  const src = readFileSync(new URL('../scripts/vite-plugin-jira.js', import.meta.url), 'utf8');

  assert.match(src, /apply: 'serve'/, 'a token-bearing endpoint must not exist in a build');

  // The GET handler tells the UI what it can do, never what the credential is.
  const get = src.slice(src.indexOf("req.method === 'GET'"), src.indexOf("req.method !== 'POST'"));
  assert.ok(!/token/.test(get.replace(/canCreate[^\n]*/g, '')), 'the probe must not leak the token');
  assert.match(get, /canCreate/);

  // And nothing logs it.
  for (const line of src.split('\n')) {
    if (!line.includes('console.log')) continue;
    assert.ok(!/token|authorization|Basic/i.test(line), `logs a credential: ${line.trim()}`);
  }
});

test('the middleware does not import from src/', () => {
  // Same rule as the tenant proxy: it must stay standalone, or a refactor in src breaks the
  // dev server in a way the app tests would not catch.
  const src = readFileSync(new URL('../scripts/vite-plugin-jira.js', import.meta.url), 'utf8');
  assert.ok(!/from '\.\.\/src/.test(src));
});
