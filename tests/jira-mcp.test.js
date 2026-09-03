/**
 * The two pieces of the Jira-over-MCP path that can be tested without a Jira: response framing and
 * the OAuth request construction.
 *
 * Neither is covered by the ticket tests, and both are where a mistake would be silent — a reply
 * picked out of the wrong SSE frame, or an authorization URL missing the one parameter that makes
 * the flow safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { decode, extractMessage, textOf } from '../scripts/jira-mcp/mcp.js';
import { authorizeUrl, parseResourceMetadata, pkce } from '../scripts/jira-mcp/oauth.js';

/* ── response framing ───────────────────────────────────────────────────── */

const sse = (...blocks) => blocks.join('\n\n') + '\n\n';
const frame = (obj) => `event: message\ndata: ${JSON.stringify(obj)}`;

test('a plain JSON reply is read as one', () => {
  const reply = extractMessage('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}', 'application/json', 7);
  assert.deepEqual(reply.result, { ok: true });
});

test('a batch reply yields the member answering our request', () => {
  const raw = JSON.stringify([
    { jsonrpc: '2.0', id: 6, result: 'someone else' },
    { jsonrpc: '2.0', id: 7, result: 'ours' },
  ]);
  assert.equal(extractMessage(raw, 'application/json', 7).result, 'ours');
  assert.equal(extractMessage(raw, 'application/json', 99), null);
});

test('an SSE reply is read out of its frame', () => {
  const raw = sse(frame({ jsonrpc: '2.0', id: 7, result: { tools: [] } }));
  assert.deepEqual(extractMessage(raw, 'text/event-stream; charset=utf-8', 7).result, { tools: [] });
});

test('progress notifications before the answer are skipped, not mistaken for it', () => {
  // The failure this guards: taking the first frame and reporting a progress ping as the result.
  const raw = sse(
    frame({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }),
    frame({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } }),
    frame({ jsonrpc: '2.0', id: 7, result: 'the answer' })
  );
  assert.equal(extractMessage(raw, 'text/event-stream', 7).result, 'the answer');
});

test('a reply to a different request is not ours', () => {
  const raw = sse(frame({ jsonrpc: '2.0', id: 3, result: 'not ours' }));
  assert.equal(extractMessage(raw, 'text/event-stream', 7), null);
});

test('a data payload split across lines is rejoined', () => {
  // SSE concatenates an event's data: lines with a newline, so a server may split a message at any
  // point where a newline is insignificant. Joining with anything else would corrupt the JSON.
  const raw = 'event: message\ndata: {"jsonrpc":"2.0","id":7,\ndata: "result":{"deep":{"nested":true}}}\n\n';
  assert.deepEqual(extractMessage(raw, 'text/event-stream', 7).result, { deep: { nested: true } });
});

test('a stream-level error with no id is reported rather than swallowed', () => {
  const raw = sse(frame({ jsonrpc: '2.0', error: { code: -32000, message: 'session expired' } }));
  assert.equal(extractMessage(raw, 'text/event-stream', 7).error.message, 'session expired');
});

test('an empty or unparseable body is null, not a crash', () => {
  assert.equal(extractMessage('', 'application/json', 1), null);
  assert.equal(extractMessage('<html>gateway timeout</html>', 'application/json', 1), null);
  assert.equal(extractMessage(sse('data: not json'), 'text/event-stream', 1), null);
  assert.equal(extractMessage(sse('data: [DONE]'), 'text/event-stream', 1), null);
});

/* ── tool results ───────────────────────────────────────────────────────── */

test('structured content is preferred over the text rendering of it', () => {
  const result = {
    structuredContent: { key: 'EMBL-1' },
    content: [{ type: 'text', text: 'Created EMBL-1 in the Embedded Auth project.' }],
  };
  assert.deepEqual(decode(result), { key: 'EMBL-1' });
});

test('JSON in a text block is parsed, prose is left as prose', () => {
  assert.deepEqual(decode({ content: [{ type: 'text', text: '{"key":"EMBL-2"}' }] }), { key: 'EMBL-2' });
  assert.equal(decode({ content: [{ type: 'text', text: 'Issue created.' }] }), 'Issue created.');
  assert.equal(decode({ content: [] }), null);
  assert.equal(decode(null), null);
});

test('non-text content does not corrupt the text', () => {
  const result = { content: [{ type: 'image', data: '…' }, { type: 'text', text: 'EMBL-3' }] };
  assert.equal(textOf(result), 'EMBL-3');
});

/* ── the OAuth request ──────────────────────────────────────────────────── */

test('the resource metadata URL is read off the challenge', () => {
  const header = 'Bearer resource_metadata="https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp", error="invalid_token"';
  assert.equal(
    parseResourceMetadata(header),
    'https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp'
  );
  assert.equal(parseResourceMetadata('Bearer realm="jira"'), null);
  assert.equal(parseResourceMetadata(null), null);
});

test('the challenge is the S256 of the verifier, base64url and unpadded', () => {
  const { verifier, challenge } = pkce();

  const expected = createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);

  // RFC 7636: the verifier is 43–128 characters of unreserved alphabet, and neither value may
  // carry base64 padding or the two characters that need escaping in a query string.
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier is ${verifier.length} chars`);
  for (const value of [verifier, challenge]) assert.match(value, /^[A-Za-z0-9\-_]+$/);
});

test('two verifiers are never the same', () => {
  const seen = new Set(Array.from({ length: 50 }, () => pkce().verifier));
  assert.equal(seen.size, 50);
});

test('the authorization URL carries everything that makes the flow safe', () => {
  const url = new URL(authorizeUrl({
    metadata: { authorization_endpoint: 'https://auth.atlassian.com/authorize' },
    clientId: 'abc123',
    redirectUri: 'http://localhost:5177/__jira/callback',
    scopes: ['read:jira:agent-interface', 'offline_access'],
    state: 'st4te',
    challenge: 'ch4llenge',
    resource: 'https://mcp.atlassian.com/v2/mcp',
  }));

  assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), 'abc123');
  assert.equal(p.get('redirect_uri'), 'http://localhost:5177/__jira/callback');
  assert.equal(p.get('state'), 'st4te');
  assert.equal(p.get('code_challenge'), 'ch4llenge');

  // The three that matter most, each for its own reason:
  assert.equal(p.get('code_challenge_method'), 'S256', 'plain would leave the code unprotected');
  assert.equal(p.get('resource'), 'https://mcp.atlassian.com/v2/mcp', 'RFC 8707 binds the token to one server');
  assert.equal(p.get('scope'), 'read:jira:agent-interface offline_access', 'scopes are space delimited');

  // A public client sends no secret, and there is nowhere in this URL one could hide.
  assert.equal(p.get('client_secret'), null);
});
