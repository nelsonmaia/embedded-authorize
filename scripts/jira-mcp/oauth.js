/**
 * OAuth 2.1 for the Atlassian Remote MCP Server — discovery, registration, PKCE, tokens.
 *
 * The point of this file is that nothing here is pre-registered and nothing is shared. Atlassian's
 * classic 3LO requires a `client_secret`, which for a tool each developer runs on their own machine
 * means a shared secret sitting next to the repo. The MCP authorization server takes a different
 * shape, and we verified every step of it against the live endpoints:
 *
 *   token_endpoint_auth_methods_supported  includes "none"   → public client, no secret at all
 *   code_challenge_methods_supported       ["S256"]          → PKCE, and only the strong method
 *   registration_endpoint                  present           → the client registers itself
 *   a http://localhost/… redirect_uri      accepted          → no hosting required
 *
 * So the dev server registers itself the first time you connect, and the only credential in the
 * system is the one Atlassian issues to whoever pressed the button.
 *
 * Deliberately standalone: this file must not import from src/.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 */

import { createHash, randomBytes } from 'node:crypto';

/** The MCP server we want a token for. Also the RFC 8707 `resource` on every OAuth request. */
export const MCP_RESOURCE = 'https://mcp.atlassian.com/v2/mcp';

/**
 * What we ask for, in preference order, intersected with what the resource advertises.
 * `offline_access` earns a refresh token; without it the connection dies at the first expiry.
 */
const WANTED_SCOPES = [
  'read:jira:agent-interface',
  'write:jira:agent-interface',
  'search:jira:agent-interface',
  'read:me',
  'offline_access',
];

const timeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

async function getJson(url, init = {}, ms = 15000) {
  const t = timeout(ms);
  try {
    const res = await fetch(url, { ...init, signal: t.signal });
    const body = await res.json().catch(() => null);
    return { res, body };
  } finally {
    t.done();
  }
}

/* ── discovery ──────────────────────────────────────────────────────────── */

/**
 * Walk the RFC 9728 chain the MCP spec mandates: an unauthenticated call answers 401 with a
 * `WWW-Authenticate` naming the protected-resource metadata, which names the authorization server,
 * which describes its own endpoints. Nothing is hardcoded, so if Atlassian moves the authorization
 * server this keeps working.
 */
export async function discover(resource = MCP_RESOURCE) {
  let metadataUrl = null;

  const t = timeout(15000);
  try {
    const probe = await fetch(resource, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
      signal: t.signal,
    });
    metadataUrl = parseResourceMetadata(probe.headers.get('www-authenticate'));
  } catch {
    /* fall through to the conventional location */
  } finally {
    t.done();
  }

  if (!metadataUrl) {
    const u = new URL(resource);
    metadataUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
  }

  const { res: prmRes, body: prm } = await getJson(metadataUrl);
  if (!prmRes.ok || !prm?.authorization_servers?.length) {
    throw new Error(`No protected-resource metadata at ${metadataUrl} (HTTP ${prmRes.status})`);
  }

  const issuer = prm.authorization_servers[0];
  const as = await authorizationServerMetadata(issuer);

  for (const required of ['authorization_endpoint', 'token_endpoint']) {
    if (!as[required]) throw new Error(`Authorization server metadata is missing ${required}`);
  }
  if (!(as.code_challenge_methods_supported ?? []).includes('S256')) {
    // Refuse rather than silently downgrade: a public client without PKCE has no protection at all
    // on the authorization code, which is the whole argument this console makes about /e/authorize.
    throw new Error('The authorization server does not advertise PKCE S256; refusing to continue.');
  }

  const supported = new Set(prm.scopes_supported ?? []);
  const scopes = supported.size ? WANTED_SCOPES.filter((s) => supported.has(s)) : WANTED_SCOPES;

  return { resource, issuer, metadata: as, scopes, scopesSupported: [...supported] };
}

/** `Bearer resource_metadata="https://…", error="invalid_token"` → the URL, or null. */
export function parseResourceMetadata(header) {
  return header ? (header.match(/resource_metadata="([^"]+)"/) ?? [])[1] ?? null : null;
}

/**
 * RFC 8414 puts `.well-known` between host and path; OpenID Connect appends it to the issuer.
 * Atlassian answers on both, but other servers pick one, so try the standard form first.
 */
async function authorizationServerMetadata(issuer) {
  const u = new URL(issuer);
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`,
    `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
  ];

  for (const url of candidates) {
    const { res, body } = await getJson(url);
    if (res.ok && body?.token_endpoint) return body;
  }
  throw new Error(`No authorization server metadata for ${issuer}`);
}

/* ── registration ───────────────────────────────────────────────────────── */

/**
 * RFC 7591 dynamic registration, as a public client.
 *
 * Atlassian returns a `client_secret` even though it declares `token_endpoint_auth_method: "none"`.
 * We neither send it nor store it: the token exchange is PKCE-only, so keeping the secret would
 * create exactly the durable credential this whole approach exists to avoid.
 */
export async function register({ registrationEndpoint, redirectUri, clientName }) {
  if (!registrationEndpoint) {
    throw new Error(
      'This authorization server does not support dynamic client registration, so a client ID ' +
        'would have to be issued by hand.'
    );
  }

  const { res, body } = await getJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });

  if (!res.ok || !body?.client_id) {
    throw new Error(`Registration failed (HTTP ${res.status}): ${body?.error_description ?? body?.error ?? 'no client_id'}`);
  }
  return { clientId: body.client_id, redirectUri };
}

/* ── the authorization code leg ─────────────────────────────────────────── */

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A verifier and its S256 challenge — the same construction the console requires of its own callers. */
export function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export const randomState = () => base64url(randomBytes(16));

export function authorizeUrl({ metadata, clientId, redirectUri, scopes, state, challenge, resource }) {
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource, // RFC 8707: MUST be sent, and binds the token to this MCP server alone
    prompt: 'consent',
  }).toString();
  return url.toString();
}

async function token(metadata, params) {
  const t = timeout(20000);
  try {
    const res = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: t.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(body.error_description || body.error || `Token endpoint answered ${res.status}`);
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      scope: body.scope ?? null,
      // A minute of slack, so a call is never made with a token that expires in flight.
      expiresAt: body.expires_in ? Date.now() + (body.expires_in - 60) * 1000 : null,
    };
  } finally {
    t.done();
  }
}

export const exchangeCode = ({ metadata, clientId, redirectUri, code, verifier, resource }) =>
  token(metadata, {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource,
  });

export const refreshTokens = ({ metadata, clientId, refreshToken, resource }) =>
  token(metadata, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource });
