# Handover

State as of 2026-09-04. The README explains what the console *is*; this file is for whoever picks
up the work, and covers what is done, what is blocked, and the things that are not obvious from
reading the code.

## Where it stands

Everything builds and passes: **192 unit assertions** (`npm test`), **66 browser checks**
(`node tests/e2e-browser.mjs`, needs `npm run dev` running), clean `npm run build`.

Recent work, oldest first:

| | |
|---|---|
| Conformance checker | every live response is checked against `src/data/spec.js`; findings render per exchange |
| PKCE mandatory | required in the end state; the tenant cannot accept it at all (see below) |
| Jira over MCP | file a finding as an issue, authenticated as whoever pressed Connect |
| Deployed server | `server.js` serves the build *and* the tenant proxy |
| Per-browser sessions | Jira tokens are per session, so a deployment is safe |

## Two open blockers

Neither is a code defect. Both were diagnosed by reproducing over an ngrok tunnel with the real
production server, which is the fastest way to check either of them again.

### 1. The deployment serves static files instead of running the server

**Symptom.** `POST /__tenant` returns `405 Method Not Allowed` on the deployed console at
`embedded-authorize.a0-b2c-core.platform.atko.ai`. It looks like an HTTP-method problem or a CORS
problem and is neither.

**Cause.** `/__tenant` needs a server. A static file host answers a POST to a path it has no file
for with 405. The built bundle still *calls* `/__tenant` — only the handler is absent.

**Fix.** Make the platform run `node server.js` rather than serve `dist/`. The `Dockerfile` already
does this correctly if the platform builds from one. `PLAYGROUND_ALLOWED_HOSTS` must be set or the
proxy forwards nothing by design.

**Proof it is only deployment.** The same build behind `node server.js` + ngrok reached the real
tenant and rendered a genuine `403 insufficient_authorization` with `auth_session` and `next[]`.

### 2. Atlassian's org policy blocks the Jira OAuth redirect domain

**Symptom.** Connect to Jira reaches Atlassian's consent screen, which then says *"Access to this
domain is restricted — your admin has blocked this domain in your organization's settings"*, with
**Accept greyed out**. Nothing appears in the server log because the flow never returns.

**Cause.** An Atlassian organisation-level restriction on OAuth redirect domains. Everything up to
that point works: discovery, dynamic client registration, PKCE, and the site picker correctly found
`ppluk.atlassian.net`.

**Fix.** An Atlassian org admin must allow the redirect domain. Ask for the **deployment** domain,
not a tunnel domain. No code change can get past this.

## What is verified, and what is not

Verified against live endpoints: the whole OAuth chain — RFC 9728 discovery (`401` →
`WWW-Authenticate` → protected-resource metadata → authorization-server metadata), dynamic client
registration returning a public client, PKCE `S256`, the authorization redirect, the callback route,
session cookies with the right flags, and Atlassian rendering our consent screen.

**Not verified: the three Jira tool calls** — `createJiraIssue`, `getVisibleJiraProjects`,
`getJiraProjectIssueTypesMetadata`. Reaching them needs a completed consent, which blocker 2
prevents. Two things to check the first time one succeeds:

1. Whether `createJiraIssue` renders the description. `ticketFor()` emits Jira wiki markup (`h3.`,
   `{code:json}`) because REST v2 and the deep-link fallback both take it. If the agent interface
   wants markdown instead it is a one-line change, and the test asserting both routes produce
   identical text will keep them in step.
2. The argument names. They are not hardcoded — each call is fitted to the schema the server
   advertises through `tools/list`, with a few aliases tried in order, so a mismatch surfaces as the
   tool's own error text. `GET /__jira/tools` lists what the tools actually accept.

## Reproducing either blocker

```
npm run build
echo 'PLAYGROUND_ALLOWED_HOSTS=nelson.jp.auth0.com' > .env    # gitignored
PORT=8080 node server.js
ngrok http 8080 --domain=embedded-authorize-specs.ngrok.app   # a reserved domain
```

Then open the tunnel URL, switch to **Live tenant**, and press Send. A tunnel is needed rather than
localhost because the Jira callback must be HTTPS, and because it is the only way to exercise the
deployed shape — `Secure` cookies and the `x-forwarded-proto` handling included.

## Things that will bite you

- **This protocol answers success with `403`.** `status < 400` is wrong everywhere in this codebase;
  use `wasAccepted()` from `src/data/conformance.js`. A checker bug hid behind this once already.
- **The tenant cannot accept PKCE.** Its initiate schema is `additionalProperties: false` and
  defines no PKCE parameters, so sending `code_challenge` is a `400`. Live mode omits it deliberately
  and reports the absence as a finding. This is not a bug in the console.
- **`apply: 'serve'` on a Vite plugin means it does not exist in a build.** That is what caused
  blocker 1. Anything the deployed app calls must also be mounted in `server.js`.
- **`forward()` runs in strict mode when deployed** — exact hosts only, no `*.auth0.com` default.
  That asymmetry is deliberate; `scripts/tenant-proxy/forward.js` explains why, and there is a test
  asserting the same call succeeds in dev and is refused deployed.
- **Never put a Jira token in module state.** It was there once and meant the second visitor
  inherited the first visitor's account. `tests/jira-sessions.test.js` guards the regression.
- **The dev-server files must not import from `src/`.** Tested. They are standalone so a refactor in
  the app cannot break the server in a way the app tests would miss.
- **Nothing logs a credential.** Tested by scanning every `console.log` line in the server files.
  Keep it that way; a scope list is fine, a token is not.

## Layout

```
server.js                     the deployed console: static build + /__tenant + /__jira
scripts/tenant-proxy/         forward() — shared by the Vite middleware and server.js
scripts/jira-mcp/             oauth.js, mcp.js, sessions.js, handler.js
src/data/spec.js              the contract, as data — the source of truth for the checker
src/data/conformance.js       checkResponse(), pure over that contract
src/hooks/useJira.js          connection state; the token never reaches the browser
```
