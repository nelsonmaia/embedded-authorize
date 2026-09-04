import { HEALTH } from './endpoints.js';

/**
 * Is a server answering, or is this build being served as files?
 *
 * The question sounds trivial and is not. A static host serves the app perfectly, then answers
 * `POST /__tenant` with `405 Method Not Allowed` — because it refuses non-GET on a path it has no
 * file for, not because anything is wrong with the method. Read literally it sends you to CORS
 * settings and HTTP verbs, neither of which is involved.
 *
 * The giveaway in a real deployment's access log was `GET /__jira → 304`. Our handler sets
 * `cache-control: no-store` and has no ETag, so it cannot produce a 304; nginx's SPA fallback had
 * served index.html for it. One probe makes that legible without reading logs.
 */

/** @returns {Promise<{running: boolean, servedBy?: string, status?: number, node?: string}>} */
export async function probeServer() {
  let res;
  try {
    res = await fetch(HEALTH(), { headers: { accept: 'application/json' } });
  } catch (e) {
    return { running: false, servedBy: 'unreachable', detail: e.message };
  }

  const type = res.headers.get('content-type') ?? '';
  if (res.ok && type.includes('application/json')) {
    const body = await res.json().catch(() => null);
    // The name is checked, not merely the shape: some hosts answer everything with a JSON error.
    if (body?.server === 'embedded-authorize') return { running: true, ...body };
  }

  return {
    running: false,
    // An HTML body for a path that should never be a page is the signature of a static fallback.
    servedBy: type.includes('text/html') ? 'static' : 'unknown',
    status: res.status,
  };
}

/**
 * What to tell someone whose live call did not reach a tenant. The two causes need different
 * fixes, so they get different sentences rather than one hedged paragraph.
 */
export function explainMissingProxy(probe, status) {
  if (probe?.running) {
    return (
      `The server is running, but POST /__tenant did not reach it (HTTP ${status}). Something in ` +
      'front of it — nginx, or an ingress — is handling that path itself instead of proxying it. ' +
      'It must forward /__tenant, /__jira and /__health to the Node process.'
    );
  }

  /* Saying "HTTP 200" here would be true and useless: the static host answers /__health with the
     app's own HTML, which is a success code for the wrong document. Name what came back instead. */
  const evidence =
    probe?.servedBy === 'static'
      ? '/__health returned the app\'s HTML instead of JSON, which is what a static fallback does'
      : `/__health did not answer (HTTP ${probe?.status ?? '?'})`;

  return (
    `This build is being served as static files, not by its server: POST /__tenant gave ${status}, ` +
    `and ${evidence}. Live mode needs a server to make the call, because POST /e/authorize sends ` +
    'no CORS headers and a browser cannot reach it directly. Run `npm run dev`, or deploy with ' +
    '`node server.js` rather than serving dist/ as files.'
  );
}
