/**
 * A minimal MCP client over streamable HTTP.
 *
 * Written by hand rather than pulled from the SDK for the same reason the tenant proxy is: this
 * file has to keep working when the app around it is refactored, and a dependency that speaks a
 * protocol we only use three calls of is a poor trade. Three calls is all this is.
 *
 * The one genuine subtlety is framing. A streamable-HTTP server may answer a POST with either a
 * plain JSON body or an SSE stream, at its discretion, and Atlassian's uses both. So every response
 * is read both ways.
 *
 * Deliberately standalone: this file must not import from src/.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 60000;

export class McpSession {
  /**
   * @param {object} o
   * @param {string} o.endpoint          the MCP server URL
   * @param {() => Promise<string>} o.accessToken  resolves a currently-valid bearer token
   */
  constructor({ endpoint, accessToken }) {
    this.endpoint = endpoint;
    this.accessToken = accessToken;
    this.sessionId = null;
    this.initialized = null; // a promise, so concurrent callers share one handshake
  }

  async #post(message, { retryOn401 = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${await this.accessToken()}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      // The server assigns the session on initialize and expects it echoed on everything after.
      const assigned = res.headers.get('mcp-session-id');
      if (assigned) this.sessionId = assigned;

      if (res.status === 401) {
        // The token expired mid-session, or the session was dropped. One retry: accessToken()
        // refreshes, and a stale session id would otherwise poison every later call.
        if (!retryOn401) throw new McpAuthError('The Jira connection is no longer authorized.');
        this.sessionId = null;
        this.initialized = null;
        return this.#post(message, { retryOn401: false });
      }

      // A notification gets 202 and no body; nothing to parse.
      if (message.id === undefined) return null;

      const raw = await res.text();
      const reply = extractMessage(raw, res.headers.get('content-type') ?? '', message.id);

      if (!res.ok && !reply) throw new Error(`MCP server answered ${res.status}: ${raw.slice(0, 300)}`);
      if (!reply) throw new Error('The MCP server sent no reply to this request.');
      if (reply.error) throw new Error(reply.error.message ?? `MCP error ${reply.error.code}`);

      return reply.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async #handshake() {
    await this.#post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'embedded-authorize-console', version: '1.0.0' },
      },
    });
    // Required by the lifecycle: the server may reject calls made before it.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async ready() {
    if (!this.initialized) {
      this.initialized = this.#handshake().catch((e) => {
        this.initialized = null; // a failed handshake must not be cached
        throw e;
      });
    }
    return this.initialized;
  }

  async listTools() {
    await this.ready();
    const { tools = [] } = (await this.#post({ jsonrpc: '2.0', id: nextId(), method: 'tools/list' })) ?? {};
    return tools;
  }

  /** @returns {Promise<any>} the tool's result, decoded from whichever shape it used. */
  async call(name, args = {}) {
    await this.ready();
    const result = await this.#post({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });

    if (result?.isError) throw new McpToolError(name, textOf(result) || `${name} failed.`);
    return decode(result);
  }

  reset() {
    this.sessionId = null;
    this.initialized = null;
  }
}

export class McpAuthError extends Error {}
export class McpToolError extends Error {
  constructor(tool, message) {
    super(message);
    this.tool = tool;
  }
}

let counter = 1;
const nextId = () => ++counter;

/**
 * Pull the JSON-RPC reply out of a body that may be plain JSON or an SSE stream.
 * Exported for the tests: this is the part with edge cases, and it needs no network to exercise.
 */
export function extractMessage(raw, contentType, id) {
  if (!raw) return null;

  if (!contentType.includes('text/event-stream')) {
    try {
      const parsed = JSON.parse(raw);
      // A batch is legal; take the member answering our request.
      return Array.isArray(parsed) ? parsed.find((m) => m.id === id) ?? null : parsed;
    } catch {
      return null;
    }
  }

  // SSE: `data:` lines, one event per blank-line-separated block, and a single event's payload may
  // span several lines. Anything that is not our reply (progress notifications, keepalives) is
  // skipped rather than treated as an answer.
  let fallback = null;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!payload || payload === '[DONE]') continue;

    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }
    if (message.id === id) return message;
    if (message.error && message.id === undefined) fallback = message;
  }
  return fallback;
}

/** The concatenated text content of a tool result. */
export function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/**
 * Tools return `structuredContent` when they have it and JSON-in-a-text-block when they do not.
 * Prefer the structured form, fall back to parsing the text, and keep the text if it is prose.
 */
export function decode(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = textOf(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
