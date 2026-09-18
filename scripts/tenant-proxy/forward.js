/**
 * forward.js — the tenant call itself, independent of who is hosting it.
 *
 * `POST /e/authorize` sends no CORS headers today, so a browser cannot call a tenant directly.
 * Postman has no such problem because it is not a browser: the request happens server-side. This
 * does the same thing, and it is shared verbatim by the Vite dev middleware and the deployed
 * server so that what you test locally is what runs when it is deployed.
 *
 * There is no tenant allowlist. A console that only reaches the tenants its operator remembered to
 * name is useless to everyone else, so the deployed server forwards to whatever tenant the person
 * using it types — the same behaviour as the dev server, deliberately, rather than by omission.
 *
 * What still bounds it, because "any tenant" must not become "any request":
 *
 *   paths    three, exactly: /e/authorize, /e/discovery, /oauth/token. Not the Management API.
 *   methods  GET and POST.
 *   secrets  a client_secret in the body is refused outright; this drives public clients.
 *   domain   a routable public hostname. Never a URL — the request URL is rebuilt from validated
 *            parts — and never an address inside whatever network the server sits in, so an open
 *            proxy cannot be turned into a probe for the metadata service next door.
 *   rate     the deployed server caps calls per address; see server.js.
 *
 * Deliberately standalone: this file must not import from src/.
 */

const ALLOWED_PATHS = ['/e/authorize', '/e/discovery', '/oauth/token'];
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const UPSTREAM_TIMEOUT_MS = 15000;

/** Response headers worth surfacing. Everything else is dropped rather than blindly forwarded. */
const PASS_HEADERS = [
  'content-type',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'access-control-allow-origin',
  'location',
];

/**
 * A bare hostname, from whatever was written.
 *
 * The obvious way to name a tenant is to paste its URL, so a scheme, a path and a port are all
 * stripped rather than refused. This is also what stops the domain field from redirecting the
 * request: whatever is typed, only the host survives to reach the URL builder.
 */
export const hostOf = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');

/* Not a tenant allowlist — a check that the host is somewhere on the public internet.
   No Auth0 tenant is an IP literal or sits under .local/.internal, so refusing them costs a real
   user nothing, while leaving them in would make this a way to reach 169.254.169.254 and every
   private address the server can route to. Delete PRIVATE_SUFFIXES and IPV4_LITERAL to lift it. */
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa', '.localhost'];

function routablePublicHost(host) {
  if (!HOSTNAME_RE.test(host)) return false; // also rejects a dotless name such as `localhost`
  if (IPV4_LITERAL.test(host)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Validate an envelope and forward it. Split out from the plugin so tests can drive it as a plain
 * function with an injected fetch and logger — which is how the "never logs a secret" property is
 * proven rather than merely claimed.
 */
export async function forward(
  envelope,
  res,
  { log = () => {}, warn = () => {}, doFetch = fetch } = {}
) {
  if (!envelope || typeof envelope !== 'object') {
    return send(res, 400, { ok: false, error: 'invalid_body', detail: 'Expected a JSON object.' });
  }

  /* Public clients only. The UI never offers a client_secret field; this is the second line of
     defence so a hand-edited payload cannot smuggle one through. */
  if (envelope.body && typeof envelope.body === 'object' && 'client_secret' in envelope.body) {
    return send(res, 400, {
      ok: false,
      error: 'client_secret_rejected',
      detail:
        'This console drives public clients only and will not forward a client_secret. ' +
        'Use curl directly if you need a confidential client.',
    });
  }

  const host = hostOf(envelope.domain);
  const rawPath = String(envelope.path || '');
  const method = String(envelope.method || 'POST').toUpperCase();

  if (!host) return send(res, 400, { ok: false, error: 'missing_domain' });

  if (!routablePublicHost(host)) {
    return send(res, 400, {
      ok: false,
      error: 'invalid_domain',
      detail:
        `"${host}" is not a tenant domain this can reach. Give the hostname of an Auth0 tenant — ` +
        'for example `your-tenant.auth0.com`, or your own custom login domain.',
    });
  }

  const q = rawPath.indexOf('?');
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  const search = q === -1 ? '' : rawPath.slice(q);
  if (!ALLOWED_PATHS.includes(pathname)) {
    return send(res, 403, {
      ok: false,
      error: 'path_not_allowed',
      detail: `"${pathname}" is not allowed. Allowed: ${ALLOWED_PATHS.join(', ')}.`,
    });
  }
  if (!['GET', 'POST'].includes(method)) {
    return send(res, 403, { ok: false, error: 'method_not_allowed', detail: 'GET or POST only.' });
  }

  // Rebuilt from validated parts — a caller-supplied URL is never followed.
  const url = `https://${host}${pathname}${search}`;

  const init = { method, headers: { accept: 'application/json' }, redirect: 'manual' };
  if (method === 'POST') {
    const isForm = envelope.contentType === 'application/x-www-form-urlencoded';
    if (isForm && envelope.body && typeof envelope.body === 'object') {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(envelope.body).toString();
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(envelope.body ?? {});
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const upstream = await doFetch(url, { ...init, signal: ac.signal });
    const text = await upstream.text();
    const durationMs = Date.now() - t0;

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { _raw: text.slice(0, 4000) };
    }

    const headers = {};
    for (const h of PASS_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }

    /* Method, path, host, status, duration. Never a body — request bodies carry OTPs and
       passwords, response bodies carry authorization codes and tokens. */
    log(`  tenant  ${method} ${pathname} → ${upstream.status} (${host}, ${durationMs}ms)`);

    return send(res, 200, { ok: true, status: upstream.status, headers, body, durationMs });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    warn(`  tenant  ${method} ${pathname} → ${aborted ? 'timeout' : 'unreachable'} (${host})`);
    return send(res, 200, {
      ok: false,
      error: aborted ? 'upstream_timeout' : 'upstream_unreachable',
      // err.message only — never the request body.
      detail: aborted ? `No response within ${UPSTREAM_TIMEOUT_MS}ms.` : err.message,
    });
  } finally {
    clearTimeout(timer);
  }
}

