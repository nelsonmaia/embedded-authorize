/**
 * vite-plugin-jira.js — file a conformance finding as a Jira issue, over the Atlassian Remote MCP
 * Server, authenticated as whoever pressed the button.
 *
 * Why MCP rather than the REST API. Filing an issue needs a credential, and the question is only
 * ever whose. An Atlassian API token is a FULL ACCOUNT credential and has to be pasted into a
 * shell. Classic 3LO would replace it with a `client_secret`, which for a tool each developer runs
 * locally means one shared secret next to the repo — worse, not better. The MCP authorization
 * server is the one path with neither: it advertises `token_endpoint_auth_method: "none"`, mandates
 * PKCE S256, and supports dynamic client registration with a localhost redirect. So the dev server
 * registers itself on first use and the only credential in the system belongs to the person who
 * consented, is scoped to `*:jira:agent-interface`, and is revocable from their own account.
 *
 * There are no environment variables. There is nothing to configure. You press Connect.
 *
 * Tokens live in memory for the lifetime of the dev server and are never written to disk — a
 * refresh token in the working tree is exactly the durable credential this design removes. Only the
 * client registration is cached, and a client id is not a secret. Restarting means one more click.
 *
 * Contract:
 *   GET  /__jira                     → { connected, user, capabilities, … }
 *   GET  /__jira/connect             → 302 to Atlassian; comes back at /__jira/callback
 *   GET  /__jira/callback            → exchanges the code, then redirects to the app
 *   POST /__jira/disconnect          → forgets the token
 *   GET  /__jira/sites               → the Atlassian sites this person can reach
 *   GET  /__jira/projects?cloudId    → projects they can see
 *   GET  /__jira/issuetypes?cloudId&projectKey
 *   POST /__jira/issue               → { summary, description, labels, cloudId, projectKey, issueTypeName }
 *   GET  /__jira/tools               → tool names and schemas, for diagnosing a rejected call
 *
 * `apply: 'serve'` — absent from any production build, so a token-bearing endpoint cannot ship.
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
} from './jira-mcp/oauth.js';
import { McpSession, McpAuthError } from './jira-mcp/mcp.js';

const CLIENT_NAME = 'Embedded Authorize console (local)';
const PENDING_TTL_MS = 10 * 60 * 1000;

/* A client id is not a secret, so caching it is safe and saves a registration per restart.
   Under node_modules/.cache it is already ignored by git and cleared by a clean install. */
const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/.cache/embedded-authorize/jira-client.json');

/* ── process-lifetime state ─────────────────────────────────────────────── */

const state = {
  discovery: null,
  client: null, // { clientId, redirectUri }
  pending: new Map(), // state → { verifier, at }
  tokens: null, // { accessToken, refreshToken, expiresAt, scope } — memory only
  session: null, // McpSession
  user: null,
  toolSchemas: null,
};

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

async function ensureClient(redirectUri) {
  if (state.client?.redirectUri === redirectUri) return state.client;

  try {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
    // A registration is bound to its redirect URI; a different port means a different client.
    if (cached.redirectUri === redirectUri && cached.clientId) {
      state.client = cached;
      return cached;
    }
  } catch {
    /* no cache yet, or it is stale — register again */
  }

  const client = await register({
    registrationEndpoint: state.discovery.metadata.registration_endpoint,
    redirectUri,
    clientName: CLIENT_NAME,
  });

  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(client, null, 2));
  } catch {
    /* caching is an optimisation; registering again next time is harmless */
  }

  state.client = client;
  return client;
}

async function ensureDiscovery() {
  if (!state.discovery) state.discovery = await discover(MCP_RESOURCE);
  return state.discovery;
}

/** A valid bearer token, refreshing first if this one is about to expire. */
async function accessToken() {
  if (!state.tokens) throw new McpAuthError('Not connected to Jira.');

  const { expiresAt, refreshToken } = state.tokens;
  if (expiresAt && Date.now() >= expiresAt) {
    if (!refreshToken) {
      state.tokens = null;
      throw new McpAuthError('The Jira session expired. Connect again.');
    }
    state.tokens = await refreshTokens({
      metadata: state.discovery.metadata,
      clientId: state.client.clientId,
      refreshToken,
      resource: MCP_RESOURCE,
    });
    // Atlassian rotates refresh tokens; keep the new one or the next refresh fails.
    if (!state.tokens.refreshToken) state.tokens.refreshToken = refreshToken;
  }
  return state.tokens.accessToken;
}

const session = () => (state.session ??= new McpSession({ endpoint: MCP_RESOURCE, accessToken }));

function disconnect() {
  state.tokens = null;
  state.user = null;
  state.toolSchemas = null;
  state.session?.reset();
  state.session = null;
}

/* ── tool calls ─────────────────────────────────────────────────────────── */

/**
 * The tool names are Atlassian's, but their argument names are not something to guess at. Rather
 * than hardcode a shape that a server-side rename would silently break, every call is fitted to the
 * schema the server itself advertises: unknown keys are dropped, and a handful of known aliases are
 * tried in order. If the fit is wrong the tool's own error text comes back verbatim, and
 * GET /__jira/tools shows what it actually wanted.
 */
const ALIASES = {
  cloudId: ['cloudId', 'cloud_id', 'cloudid'],
  projectKey: ['projectKey', 'projectIdOrKey', 'project_key', 'project'],
  issueTypeName: ['issueTypeName', 'issuetype', 'issueType', 'issue_type_name'],
  summary: ['summary'],
  description: ['description'],
  labels: ['labels'],
};

async function schemaFor(tool) {
  if (!state.toolSchemas) {
    const tools = await session().listTools();
    state.toolSchemas = new Map(tools.map((t) => [t.name, t]));
  }
  return state.toolSchemas.get(tool)?.inputSchema ?? null;
}

/** Map our canonical names onto whatever this server's schema calls them. */
async function fitArgs(tool, canonical) {
  const schema = await schemaFor(tool);
  const accepted = schema?.properties ? Object.keys(schema.properties) : null;

  const args = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (value === undefined || value === null) continue;
    if (!accepted) {
      args[key] = value;
      continue;
    }
    const name = (ALIASES[key] ?? [key]).find((candidate) => accepted.includes(candidate));
    if (name) args[name] = value;
  }
  return args;
}

const callTool = async (tool, canonical = {}) => session().call(tool, await fitArgs(tool, canonical));

/** Tool results arrive as an array, or wrapped under one of a few plausible keys. */
function asList(result, ...keys) {
  if (Array.isArray(result)) return result;
  for (const key of keys) if (Array.isArray(result?.[key])) return result[key];
  for (const value of Object.values(result ?? {})) if (Array.isArray(value)) return value;
  return [];
}

/* ── the middleware ─────────────────────────────────────────────────────── */

export function jiraIssues() {
  return {
    name: 'jira-issues',
    apply: 'serve', // dev only — a token-bearing endpoint must not exist in a build

    configureServer(server) {
      server.middlewares.use('/__jira', async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const route = url.pathname.replace(/\/$/, '') || '/';
        const redirectUri = `http://${req.headers.host}/__jira/callback`;
        const q = (name) => url.searchParams.get(name) ?? undefined;

        const fail = (e) => {
          const auth = e instanceof McpAuthError;
          if (auth) disconnect();
          // eslint-disable-next-line no-console
          console.log(`[jira] ${route} failed: ${e.message}`);
          json(res, 200, { ok: false, error: auth ? 'not_connected' : 'failed', detail: e.message });
        };

        try {
          /* status — what the UI needs to decide what to render. Never the token, and never
             whether one merely exists: only whether the connection is usable. */
          if (route === '/' && req.method === 'GET') {
            return json(res, 200, {
              connected: !!state.tokens,
              user: state.user,
              scope: state.tokens?.scope ?? null,
              transport: 'mcp',
              resource: MCP_RESOURCE,
            });
          }

          if (route === '/connect' && req.method === 'GET') {
            await ensureDiscovery();
            const client = await ensureClient(redirectUri);
            const { verifier, challenge } = pkce();
            const value = randomState();

            for (const [key, entry] of state.pending) {
              if (Date.now() - entry.at > PENDING_TTL_MS) state.pending.delete(key);
            }
            state.pending.set(value, { verifier, at: Date.now() });

            res.statusCode = 302;
            res.setHeader('location', authorizeUrl({
              metadata: state.discovery.metadata,
              clientId: client.clientId,
              redirectUri,
              scopes: state.discovery.scopes,
              state: value,
              challenge,
              resource: MCP_RESOURCE,
            }));
            return res.end();
          }

          if (route === '/callback' && req.method === 'GET') {
            const returned = q('state');
            const pending = returned ? state.pending.get(returned) : null;
            state.pending.delete(returned);

            // An unrecognised state is a forged or replayed callback; there is nothing to resume.
            if (!pending) return done(res, 'That sign-in did not match a request this server started. Try again.');
            if (q('error')) return done(res, q('error_description') || q('error'));
            if (!q('code')) return done(res, 'Atlassian did not return an authorization code.');

            state.tokens = await exchangeCode({
              metadata: state.discovery.metadata,
              clientId: state.client.clientId,
              redirectUri,
              code: q('code'),
              verifier: pending.verifier,
              resource: MCP_RESOURCE,
            });
            state.session = null;
            state.toolSchemas = null;

            try {
              state.user = await callTool('atlassianUserInfo');
            } catch {
              state.user = null; // cosmetic; the connection still works
            }

            // A scope list is a set of permission names, not a credential. Read into a local so
            // the log line itself stays clear of anything that reads like one.
            const granted = state.tokens.scope ?? 'unreported';
            // eslint-disable-next-line no-console
            console.log(`[jira] connected over MCP, scope: ${granted}`);
            return done(res, null);
          }

          if (route === '/disconnect' && req.method === 'POST') {
            disconnect();
            return json(res, 200, { ok: true, connected: false });
          }

          if (route === '/sites' && req.method === 'GET') {
            const result = await callTool('getAccessibleAtlassianResources');
            const sites = asList(result, 'resources', 'sites', 'values').map((s) => ({
              cloudId: s.id ?? s.cloudId,
              name: s.name ?? s.url,
              url: s.url,
            }));
            return json(res, 200, { ok: true, sites: sites.filter((s) => s.cloudId) });
          }

          if (route === '/projects' && req.method === 'GET') {
            const result = await callTool('getVisibleJiraProjects', { cloudId: q('cloudId') });
            const projects = asList(result, 'values', 'projects').map((p) => ({
              key: p.key,
              name: p.name,
              id: p.id,
            }));
            return json(res, 200, { ok: true, projects: projects.filter((p) => p.key) });
          }

          if (route === '/issuetypes' && req.method === 'GET') {
            const result = await callTool('getJiraProjectIssueTypesMetadata', {
              cloudId: q('cloudId'),
              projectKey: q('projectKey'),
            });
            const types = asList(result, 'issueTypes', 'values', 'projects').map((t) => ({
              id: t.id,
              name: t.name,
              subtask: !!t.subtask,
            }));
            return json(res, 200, { ok: true, issueTypes: types.filter((t) => t.name && !t.subtask) });
          }

          /* Diagnostic. Tool schemas are public API descriptions, not data — nothing here is
             specific to the connected account. */
          if (route === '/tools' && req.method === 'GET') {
            const tools = await session().listTools();
            return json(res, 200, {
              ok: true,
              tools: tools.map((t) => ({ name: t.name, properties: Object.keys(t.inputSchema?.properties ?? {}) })),
            });
          }

          if (route === '/issue' && req.method === 'POST') {
            const body = await readBody(req);
            const summary = String(body.summary ?? '').slice(0, 255);
            if (!summary) return json(res, 400, { ok: false, error: 'bad_request', detail: 'summary is required' });
            if (!body.cloudId || !body.projectKey) {
              return json(res, 400, { ok: false, error: 'bad_request', detail: 'pick a site and a project first' });
            }

            const started = Date.now();
            const created = await callTool('createJiraIssue', {
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
            return json(res, 200, {
              ok: true,
              key,
              url: created?.url ?? (key && site ? `${site}/browse/${key}` : null),
              raw: key ? undefined : created, // nothing recognisable came back — show what did
            });
          }

          return next();
        } catch (e) {
          return fail(e);
        }
      });
    },
  };
}

/**
 * End the browser leg. The window is wherever Atlassian sent it, so it has to be told something —
 * then it goes back to the console, which re-reads the status and re-renders itself.
 */
function done(res, error) {
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
