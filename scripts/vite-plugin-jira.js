/**
 * vite-plugin-jira.js — file a conformance finding as a Jira issue, from the dev server.
 *
 * The credential is the reason this is server-side. An Atlassian API token is a FULL ACCOUNT
 * credential: it can do anything its owner can, across every Jira and Confluence on the site. That
 * is strictly worse than the `client_secret` the tenant proxy already refuses to forward, so it
 * never reaches the browser, never lands in sessionStorage, and never appears in a request the
 * console displays. It lives in the shell that ran `npm run dev` and nowhere else.
 *
 * Contract:  GET  /__jira  → { site, projectKey, issueTypeId, projectId, canCreate }
 *            POST /__jira  { summary, description, labels }
 *                          → { ok: true, key, url } | { ok: false, error, detail }
 *
 * `apply: 'serve'` — absent from any production build, so a token-bearing endpoint cannot ship.
 * Deliberately standalone: this file must not import from src/.
 *
 * Configure with, in the shell running the dev server:
 *   JIRA_SITE=your-site            (or your-site.atlassian.net)
 *   JIRA_EMAIL=you@example.com
 *   JIRA_TOKEN=…                   from id.atlassian.com → API tokens
 *   JIRA_PROJECT=EMBL              project key
 *   JIRA_ISSUETYPE=10004           optional; the id of Bug/Task in that project
 *   JIRA_PROJECT_ID=10001          optional; numeric id, only for the deep-link fallback
 *
 * With JIRA_SITE and JIRA_PROJECT_ID alone the console falls back to a prefilled create-issue URL.
 * Only the token turns the button into a real one-click.
 */

const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_SUMMARY = 255;

const env = (name) => (process.env[name] || '').trim();

function config() {
  const site = env('JIRA_SITE');
  return {
    site: site && !site.includes('.') ? `${site}.atlassian.net` : site,
    projectKey: env('JIRA_PROJECT'),
    issueTypeId: env('JIRA_ISSUETYPE'),
    projectId: env('JIRA_PROJECT_ID'),
    email: env('JIRA_EMAIL'),
    token: env('JIRA_TOKEN'),
  };
}

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function jiraIssues() {
  return {
    name: 'jira-issues',
    apply: 'serve', // dev only — a token-bearing endpoint must not exist in a build

    configureServer(server) {
      server.middlewares.use('/__jira', async (req, res, next) => {
        const { site, projectKey, issueTypeId, projectId, email, token } = config();

        /* What the UI needs to decide which button to render. Never includes the token, and never
           says whether one is merely present — only whether the whole set is usable. */
        if (req.method === 'GET') {
          return json(res, 200, {
            site: site || null,
            projectKey: projectKey || null,
            issueTypeId: issueTypeId || null,
            projectId: projectId || null,
            canCreate: !!(site && projectKey && email && token),
          });
        }

        if (req.method !== 'POST') return next();

        if (!(site && projectKey && email && token)) {
          return json(res, 400, {
            ok: false,
            error: 'not_configured',
            detail:
              'Set JIRA_SITE, JIRA_PROJECT, JIRA_EMAIL and JIRA_TOKEN in the shell running the dev ' +
              'server. Without them the console falls back to a prefilled create-issue link.',
          });
        }

        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return json(res, 400, { ok: false, error: 'bad_request', detail: e.message });
        }

        const summary = String(body.summary || '').slice(0, MAX_SUMMARY);
        if (!summary) {
          return json(res, 400, { ok: false, error: 'bad_request', detail: 'summary is required' });
        }

        const fields = {
          project: { key: projectKey },
          summary,
          description: String(body.description || ''),
          ...(issueTypeId ? { issuetype: { id: String(issueTypeId) } } : { issuetype: { name: 'Task' } }),
          ...(Array.isArray(body.labels) && body.labels.length ? { labels: body.labels } : {}),
        };

        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

        try {
          /* v2, not v3: v3 requires the description as an Atlassian Document Format tree, and v2
             accepts the same text the deep-link fallback puts in a URL. One body, two paths. */
          const upstream = await fetch(`https://${site}/rest/api/2/issue`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
            },
            body: JSON.stringify({ fields }),
            signal: controller.signal,
          });

          const payload = await upstream.json().catch(() => ({}));

          // One line per call: no bodies, no headers, and above all no Authorization.
          // eslint-disable-next-line no-console
          console.log(
            `[jira] POST /rest/api/2/issue ${site} ${upstream.status} ${Date.now() - started}ms`
          );

          if (!upstream.ok) {
            return json(res, 200, {
              ok: false,
              error: 'jira_rejected',
              detail:
                payload?.errorMessages?.join('; ') ||
                Object.entries(payload?.errors ?? {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('; ') ||
                `Jira answered ${upstream.status}.`,
            });
          }

          return json(res, 200, {
            ok: true,
            key: payload.key,
            url: `https://${site}/browse/${payload.key}`,
          });
        } catch (e) {
          return json(res, 200, {
            ok: false,
            error: e.name === 'AbortError' ? 'timeout' : 'unreachable',
            detail: e.name === 'AbortError' ? `No answer in ${UPSTREAM_TIMEOUT_MS}ms.` : e.message,
          });
        } finally {
          clearTimeout(timer);
        }
      });
    },
  };
}
