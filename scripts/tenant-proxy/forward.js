/**
 * forward.js — the tenant call itself, independent of who is hosting it.
 *
 * `POST /e/authorize` sends no CORS headers today, so a browser cannot call a tenant directly.
 * Postman has no such problem because it is not a browser: the request happens server-side. This
 * does the same thing, and it is shared verbatim by the Vite dev middleware and the deployed
 * server so that what you test locally is what runs when it is deployed.
 *
 * Two very different threat models use this one function, which is what `strict` is for.
 *
 *   dev      bound to localhost, one developer, their own machine. Any Auth0 tenant is fine.
 *   deployed reachable by anyone who can reach the host. An allowlist of host SUFFIXES would make
 *            it a relay anyone could point at any tenant, from your server's IP and under your
 *            server's reputation — credential-stuffing infrastructure with a friendly UI. So
 *            strict mode drops the suffix defaults entirely: exact hosts only, named by the
 *            operator, and no allowlist means no forwarding at all.
 *
 * Deliberately standalone: this file must not import from src/.
 */

const DEFAULT_HOST_SUFFIXES = ['.auth0.com', '.auth0lab.com', '.authok.cn'];
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
 * Applied to BOTH sides of the comparison. The obvious way to configure an allowlist is to paste
 * the tenant URL, and if only the incoming domain were normalised, `https://tenant.auth0.com/`
 * would refuse every call while looking exactly right in the error message.
 */
export const hostOf = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');

function extraHosts() {
  return (process.env.PLAYGROUND_ALLOWED_HOSTS || '').split(',').map(hostOf).filter(Boolean);
}

function hostAllowed(host, { strict, allowedHosts }) {
  if (!HOSTNAME_RE.test(host)) return false;
  const named = (allowedHosts ?? extraHosts()).map(hostOf).filter(Boolean);
  // Exact match only, in either mode — a wildcard built from user input is how open relays happen.
  if (named.includes(host)) return true;
  // The convenience defaults are a dev affordance. A deployment names its tenants or forwards
  // nothing; see the header for why a suffix allowlist is not safe once others can reach the host.
  return strict ? false : DEFAULT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
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
  { log = () => {}, warn = () => {}, doFetch = fetch, strict = false, allowedHosts } = {}
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

  const named = (allowedHosts ?? extraHosts()).map(hostOf).filter(Boolean);

  /* A strict deployment with nothing named forwards nothing. Failing closed with an explanation
     beats quietly relaying to whatever was typed, and tells the operator exactly what to set. */
  if (strict && !named.length) {
    return send(res, 503, {
      ok: false,
      error: 'no_allowlist',
      detail:
        'This deployment has no tenant allowlist, so it will not forward anything. Set ' +
        'PLAYGROUND_ALLOWED_HOSTS to a comma-separated list of the exact tenant domains it may ' +
        'reach. Live mode works without this only on a local dev server.',
    });
  }

  if (!hostAllowed(host, { strict, allowedHosts })) {
    return send(res, 403, {
      ok: false,
      error: 'host_not_allowed',
      detail: strict
        ? `"${host}" is not in this deployment's tenant allowlist. Allowed: ${named.join(', ')}.`
        : `"${host}" is not allowed. Allowed suffixes: ${DEFAULT_HOST_SUFFIXES.join(', ')}. ` +
          'Add a custom domain with the PLAYGROUND_ALLOWED_HOSTS env var.',
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

