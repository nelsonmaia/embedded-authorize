/**
 * handler.js — file a conformance finding as a Jira issue, over the Atlassian Remote MCP Server,
 * authenticated as whoever pressed the button in that browser.
 *
 * Why MCP rather than the REST API. Filing an issue needs a credential, and the question is only
 * ever whose. An Atlassian API token is a FULL ACCOUNT credential and has to be pasted into a
 * shell. Classic 3LO would replace it with a `client_secret`, which for a tool run in several
 * places means one shared secret — worse, not better. The MCP authorization server is the one path
 * with neither: it advertises `token_endpoint_auth_method: "none"`, mandates PKCE S256, and
 * supports dynamic client registration. So the server registers itself on first use and the only
 * credential in the system belongs to the person who consented.
 *
 * There are no environment variables. There is nothing to configure. You press Connect.
 *
 * Tokens are held per browser session (see ./sessions.js) and never written to disk. Only the
 * client registration is cached, and a client id is not a secret. What IS shared across sessions is
 * only what is public: the discovery documents and that registration.
 *
 * Contract:
 *   GET  /__jira                     → { connected, user, … }
 *   GET  /__jira/connect             → 302 to Atlassian; comes back at /__jira/callback
 *   GET  /__jira/callback            → exchanges the code, then redirects to the app
 *   POST /__jira/disconnect          → forgets this browser's token
 *   GET  /__jira/sites               → the Atlassian sites this person can reach
 *   GET  /__jira/projects?cloudId    → projects they can see
 *   GET  /__jira/issuetypes?cloudId&projectKey
 *   POST /__jira/issue               → { summary, description, labels, cloudId, projectKey, … }
 *   GET  /__jira/tools               → tool names and schemas, for diagnosing a rejected call
 *
 * Deliberately standalone: this file must not import from src/.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_RESOURCE,
  authorizeUrl,
  discover,
  exchangeCode,
  pkce,
  randomState,
  refreshTokens,
  register,
} from './oauth.js';
import { McpSession, McpAuthError } from './mcp.js';
import { isSecure, sessionFor, signOut } from './sessions.js';

const CLIENT_NAME = 'Embedded Authorize console';
const PENDING_TTL_MS = 10 * 60 * 1000;

/* A client id is not a secret, so caching it is safe and saves a registration per restart.
   Under node_modules/.cache it is already ignored by git and cleared by a clean install. */
const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.cache/embedded-authorize/jira-client.json');

/* Shared across sessions because none of it is anyone's: the discovery documents are public and
   the registration identifies this console, not a person. */
const shared = { discovery: null, client: null };

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
};

function readBody(req) {
  return new Promise((ok, fail) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) fail(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(raw || '{}'));
      } catch {
        fail(new Error('body is not JSON'));
      }
    });
    req.on('error', fail);
  });
}

/* ── connection ─────────────────────────────────────────────────────────── */

async function ensureDiscovery() {
  if (!shared.discovery) shared.discovery = await discover(MCP_RESOURCE);
  return shared.discovery;
}

async function ensureClient(redirectUri) {
  if (shared.client?.redirectUri === redirectUri) return shared.client;

  try {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
    // A registration is bound to its redirect URI; a different host or port means a different one.
    if (cached.redirectUri === redirectUri && cached.clientId) {
      shared.client = cached;
      return cached;
    }
  } catch {
    /* no cache yet, or it is for somewhere else — register again */
  }

  const client = await register({
    registrationEndpoint: shared.discovery.metadata.registration_endpoint,
    redirectUri,
    clientName: CLIENT_NAME,
  });

  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(client, null, 2));
  } catch {
    /* caching is an optimisation; registering again next time is harmless */
  }

  shared.client = client;
  return client;
}

/** A valid bearer token for THIS session, refreshing first if it is about to expire. */
const tokenGetter = (session) => async () => {
  if (!session.tokens) throw new McpAuthError('Not connected to Jira.');

  const { expiresAt, refreshToken } = session.tokens;
  if (expiresAt && Date.now() >= expiresAt) {
    if (!refreshToken) {
      signOut(session);
      throw new McpAuthError('The Jira session expired. Connect again.');
    }
    session.tokens = await refreshTokens({
      metadata: shared.discovery.metadata,
      clientId: shared.client.clientId,
      refreshToken,
      resource: MCP_RESOURCE,
    });
    // Atlassian rotates refresh tokens; keep the new one or the next refresh fails.
    if (!session.tokens.refreshToken) session.tokens.refreshToken = refreshToken;
  }
  return session.tokens.accessToken;
};

const mcpFor = (session) =>
  (session.mcp ??= new McpSession({ endpoint: MCP_RESOURCE, accessToken: tokenGetter(session) }));

/* ── tool calls ─────────────────────────────────────────────────────────── */

/**
 * The tool names are Atlassian's, but their argument names are not something to guess at. Rather
 * than hardcode a shape a server-side rename would silently break, every call is fitted to the
 * schema the server itself advertises. If the fit is wrong the tool's own error text comes back
 * verbatim, and GET /__jira/tools shows what it actually wanted.
 */
const ALIASES = {
  cloudId: ['cloudId', 'cloud_id', 'cloudid'],
  projectKey: ['projectKey', 'projectIdOrKey', 'project_key', 'project'],
  issueTypeName: ['issueTypeName', 'issuetype', 'issueType', 'issue_type_name'],
  summary: ['summary'],
  description: ['description'],
  labels: ['labels'],
};

async function fitArgs(session, tool, canonical) {
  if (!session.toolSchemas) {
    const tools = await mcpFor(session).listTools();
    session.toolSchemas = new Map(tools.map((t) => [t.name, t]));
  }
  const accepted = session.toolSchemas.get(tool)?.inputSchema?.properties;
  const names = accepted ? Object.keys(accepted) : null;

  const args = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (value === undefined || value === null) continue;
    if (!names) {
      args[key] = value;
      continue;
    }
    const name = (ALIASES[key] ?? [key]).find((candidate) => names.includes(candidate));
    if (name) args[name] = value;
  }
  return args;
}

const callTool = async (session, tool, canonical = {}) =>
  mcpFor(session).call(tool, await fitArgs(session, tool, canonical));

/** Tool results arrive as an array, or wrapped under one of a few plausible keys. */
function asList(result, ...keys) {
  if (Array.isArray(result)) return result;
  for (const key of keys) if (Array.isArray(result?.[key])) return result[key];
  for (const value of Object.values(result ?? {})) if (Array.isArray(value)) return value;
  return [];
}

/* ── the handler ────────────────────────────────────────────────────────── */

/**
 * @param {import('node:http').IncomingMessage} req  with `req.url` relative to /__jira
 * @returns {Promise<boolean>} false when the route is not ours, so a caller can fall through
 */
export async function handleJira(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname.replace(/\/$/, '') || '/';
  const q = (name) => url.searchParams.get(name) ?? undefined;

  const { session } = sessionFor(req, res);
  // The redirect URI must match what was registered, and the MCP spec requires localhost or HTTPS.
  // Behind a TLS-terminating proxy the socket is plain, so the forwarded scheme decides.
  const redirectUri = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}/__jira/callback`;

  try {
    if (route === '/' && req.method === 'GET') {
      json(res, 200, {
        connected: !!session.tokens,
        user: session.user,
        scope: session.tokens?.scope ?? null,
        transport: 'mcp',
        resource: MCP_RESOURCE,
      });
      return true;
    }

    if (route === '/connect' && req.method === 'GET') {
      await ensureDiscovery();
      const client = await ensureClient(redirectUri);
      const { verifier, challenge } = pkce();
      const value = randomState();

      for (const [key, entry] of session.pending) {
        if (Date.now() - entry.at > PENDING_TTL_MS) session.pending.delete(key);
      }
      // Held on the session, so a state value observed elsewhere cannot be completed by another
      // browser: the verifier only exists in the one that started the flow.
      session.pending.set(value, { verifier, at: Date.now() });

      res.statusCode = 302;
      res.setHeader('location', authorizeUrl({
        metadata: shared.discovery.metadata,
        clientId: client.clientId,
        redirectUri,
        scopes: shared.discovery.scopes,
        state: value,
        challenge,
        resource: MCP_RESOURCE,
      }));
      res.end();
      return true;
    }

    if (route === '/callback' && req.method === 'GET') {
      const returned = q('state');
      const pending = returned ? session.pending.get(returned) : null;
      session.pending.delete(returned);

      // No matching state in THIS browser's session: a forged, replayed, or cross-browser
      // callback. There is nothing to resume.
      if (!pending) return finish(res, 'That sign-in did not match a request from this browser. Try again.'), true;
      if (q('error')) return finish(res, q('error_description') || q('error')), true;
      if (!q('code')) return finish(res, 'Atlassian did not return an authorization code.'), true;

      session.tokens = await exchangeCode({
        metadata: shared.discovery.metadata,
        clientId: shared.client.clientId,
        redirectUri,
        code: q('code'),
        verifier: pending.verifier,
        resource: MCP_RESOURCE,
      });
      session.mcp = null;
      session.toolSchemas = null;

      try {
        session.user = await callTool(session, 'atlassianUserInfo');
      } catch {
        session.user = null; // cosmetic; the connection still works
      }

      // A scope list is a set of permission names, not a credential.
      const granted = session.tokens.scope ?? 'unreported';
      // eslint-disable-next-line no-console
      console.log(`[jira] connected over MCP, scope: ${granted}`);
      finish(res, null);
      return true;
    }

    if (route === '/disconnect' && req.method === 'POST') {
      signOut(session);
      json(res, 200, { ok: true, connected: false });
      return true;
    }

    if (route === '/sites' && req.method === 'GET') {
      const result = await callTool(session, 'getAccessibleAtlassianResources');
      const sites = asList(result, 'resources', 'sites', 'values').map((s) => ({
        cloudId: s.id ?? s.cloudId,
        name: s.name ?? s.url,
        url: s.url,
      }));
      json(res, 200, { ok: true, sites: sites.filter((s) => s.cloudId) });
      return true;
    }

    if (route === '/projects' && req.method === 'GET') {
      const result = await callTool(session, 'getVisibleJiraProjects', { cloudId: q('cloudId') });
      const projects = asList(result, 'values', 'projects').map((p) => ({ key: p.key, name: p.name, id: p.id }));
      json(res, 200, { ok: true, projects: projects.filter((p) => p.key) });
      return true;
    }

    if (route === '/issuetypes' && req.method === 'GET') {
      const result = await callTool(session, 'getJiraProjectIssueTypesMetadata', {
        cloudId: q('cloudId'),
        projectKey: q('projectKey'),
      });
      const types = asList(result, 'issueTypes', 'values', 'projects').map((t) => ({
        id: t.id,
        name: t.name,
        subtask: !!t.subtask,
      }));
      json(res, 200, { ok: true, issueTypes: types.filter((t) => t.name && !t.subtask) });
      return true;
    }

    /* Diagnostic. Tool schemas are public API descriptions, not data — nothing here is specific to
       the connected account. */
    if (route === '/tools' && req.method === 'GET') {
      const tools = await mcpFor(session).listTools();
      json(res, 200, {
        ok: true,
        tools: tools.map((t) => ({ name: t.name, properties: Object.keys(t.inputSchema?.properties ?? {}) })),
      });
      return true;
    }

    if (route === '/issue' && req.method === 'POST') {
      const body = await readBody(req);
      const summary = String(body.summary ?? '').slice(0, 255);
      if (!summary) {
        json(res, 400, { ok: false, error: 'bad_request', detail: 'summary is required' });
        return true;
      }
      if (!body.cloudId || !body.projectKey) {
        json(res, 400, { ok: false, error: 'bad_request', detail: 'pick a site and a project first' });
        return true;
      }

      const started = Date.now();
      const created = await callTool(session, 'createJiraIssue', {
        cloudId: body.cloudId,
        projectKey: body.projectKey,
        issueTypeName: body.issueTypeName || 'Task',
        summary,
        description: String(body.description ?? ''),
        labels: Array.isArray(body.labels) && body.labels.length ? body.labels : undefined,
      });

      // One line per call: no bodies, no headers, and above all no bearer token.
      // eslint-disable-next-line no-console
      console.log(`[jira] createJiraIssue ${body.projectKey} ${Date.now() - started}ms`);

      const key = created?.key ?? created?.issueKey ?? created?.issue?.key ?? null;
      const site = String(body.siteUrl ?? '').replace(/\/$/, '');
      json(res, 200, {
        ok: true,
        key,
        url: created?.url ?? (key && site ? `${site}/browse/${key}` : null),
        raw: key ? undefined : created, // nothing recognisable came back — show what did
      });
      return true;
    }

    return false;
  } catch (e) {
    const auth = e instanceof McpAuthError;
    if (auth) signOut(session);
    // eslint-disable-next-line no-console
    console.log(`[jira] ${route} failed: ${e.message}`);
    json(res, 200, { ok: false, error: auth ? 'not_connected' : 'failed', detail: e.message });
    return true;
  }
}

/**
 * End the browser leg. The window is wherever Atlassian sent it, so it has to be told something —
 * then it goes back to the console, which re-reads the status and re-renders itself.
 */
function finish(res, error) {
  res.statusCode = error ? 400 : 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>${error ? 'Not connected' : 'Connected'}</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #fafafa; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #09090b; color: #fafafa; } }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  p { opacity: .7; }
  a { color: inherit; }
</style>
<main>
  <h1>${error ? 'Not connected' : 'Connected to Jira'}</h1>
  <p>${error ? String(error).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;')) : 'Taking you back to the console…'}</p>
  <p><a href="/">Back to the console</a></p>
</main>
${error ? '' : '<script>location.replace("/")</script>'}`);
}
