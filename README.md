# Embedded Authorize Console

> **Confluence:** none yet — internal tool.

A React app for `POST /e/authorize`. Built because the contract is server-driven — the server tells
the client what it may do next via `next: [...]` — and that inverted control flow is hard to convey
from a document. Here the request and its response sit side by side, every payload is editable, and
you can watch `next` move.

**Local only.** There is no deployed copy: live-tenant mode depends on the dev server, so a static
build could not do the interesting half.

```bash
npm install
npm run dev            # → http://localhost:5177
```

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on :5177, including the tenant proxy |
| `npm test` | 131 assertions: data fidelity, the state machine, transports, proxy allowlist + log hygiene |
| `npm run build` | Production bundle (end-state mode only — live needs the dev server) |
| `npm run extract` | Regenerate `src/data/signupPrd.generated.json` from the committed source |
| `node tests/e2e-browser.mjs` | 57 browser checks over CDP. Needs `npm run dev` running. |

## Two modes, deliberately independent

**End state** — how each flow behaves once it is fully built. Nothing leaves your browser. Two
content sets, both selected from the same dropdown:

- *Sign up* — 15 connection configurations (email / phone / both, × no / optional / required
  password) and their 26 variants, replayed from 200 modelled request/response pairs.
- *Sign in* — 30 scenarios (OTP, password, MFA, passkey, federation, bot detection, post-login
  interactions, and the protocol's own error shapes), **simulated**: the state
  machine in `src/engine/engine.js` runs, so a wrong OTP really fails, the attempt cap really trips,
  and an action outside `next[]` is really refused. Correct OTP is `123456`; correct password is
  `Abcd@1234`.

**Live tenant** — what a real tenant does right now, including where it is not finished. Every
response is checked against the contract and anything that differs is annotated beside it, under
one of three headings: **off spec** (contradicts the draft or the documented contract), **known
gap** (already recorded in `KNOWN_GAPS`), or **undocumented** (real behaviour the registry has no
entry for — which may mean the registry is stale rather than the tenant wrong). The check never
alters the response; live mode still shows exactly what came back.

Two things it catches that reading JSON side by side does not: an `auth_session` that is accepted
after being spent — invisible in any single response, so the transport tracks it — and a `next[]`
descriptor carrying a field the registry does not declare.

Neither mode falls back to the other. If a live call fails you see it fail, because a spec-shaped
answer would mean you were no longer testing your tenant.

## Editing payloads

Every request is a live textarea from first paint — there is no button to press first. It arrives
prefilled with a suggested payload; type over any part of it. Invalid JSON is reported inline and
disables **Send**. **Reset payload** restores the suggestion. **curl** copies the call.

What an edit does depends on the mode, and that difference is the point:

- **Sign up (end state)** — changing a *value* still returns the modelled response, with
  `next[].identifier` re-masked to match what you sent. Changing the *action* to something the
  variant does not do next returns nothing and says so; inventing a response would make the tool
  less trustworthy than the model it is quoting.
- **Sign in (simulated)** — edits have real consequences, because nothing is prerecorded.
- **Live** — sent verbatim to your tenant. Nothing is second-guessed.

## Live mode: why there is a dev-server middleware

`POST /e/authorize` sends no CORS headers today — `OPTIONS` returns 404 and `POST` returns no
`access-control-allow-origin` — so a browser cannot call it cross-origin. Postman has no such
problem because it is not a browser: the request is made server-side.
`scripts/vite-plugin-tenant-proxy.js` does the same thing from the Vite dev server.

It is not `server.proxy`, which resolves its `target` at config load — the tenant domain is typed at
runtime. It registers `POST /__tenant` and does its own `fetch`.

`apply: 'serve'` means it is absent from any production build, so it cannot ship as an open proxy.

Guarantees, all covered by `tests/dev-proxy.test.js`:

- Host allowlist: `.auth0.com`, `.auth0lab.com`, `.authok.cn`, plus exact-match additions via
  `PLAYGROUND_ALLOWED_HOSTS`. A URL smuggled through `domain` cannot redirect the request — the
  upstream URL is rebuilt from validated parts.
- Path allowlist: `/e/authorize`, `/e/discovery`, `/oauth/token`. GET and POST only.
- **Public clients only.** No `client_secret` field exists in the UI, and the middleware rejects a
  payload containing one with a 400.
- **Never logs a body.** One line per call: method, path, host, status, duration. Request bodies
  carry OTPs and passwords; response bodies carry authorization codes and tokens. Redaction is a
  logging concern only — the authorization code still reaches the UI, which is the point.
- Tenant config lives in `sessionStorage` and is gone when the tab closes.

CORS for `/e/authorize` is planned (Delivery 3 RFD, reusing the `allow_origins` components
EMBL-1317 shipped for discovery). Once it lands, the browser can call tenants directly and this
middleware can go.

## UI

shadcn/ui components (`src/components/ui/`), Tailwind, Radix primitives. These are vendored
copy-in sources, as shadcn intends — `components.json` is present so `npx shadcn@latest add <x>`
works for anything new. The primary is the Auth0 orange.

Light, dark and system themes. Both palettes define every token — a token present in only one is a
colour that disappears when the theme flips, which a test asserts against. "System" keeps following
the OS after you pick it rather than resolving once. An inline script in `index.html` applies the
class before first paint; doing it in React flashes the wrong theme on every load.

Note for anyone writing tests: Radix activates tabs and selects on real pointer events and ignores
a synthetic `el.click()`. `tests/e2e-browser.mjs` has a `clickReal()` helper that dispatches trusted
CDP input for this reason.

## The generated signup data

`src/data/signupPrd.generated.json` is written by `scripts/extract-signup-prd.mjs` from
`src/data/sources/signup-prd-1068894784.md` (the source page body) and its sibling `.meta.json`.
**Do not hand-edit the generated file.** To refresh:

1. Re-fetch the source page body into that `.md`.
2. Update the `.meta.json` (version, `updatedAt`).
3. `npm run extract` — it re-asserts and refuses to write on any failure.
4. `npm test` — a sha256 pin means a stale generated file is caught.

The generator asserts, rather than assumes, that the source is machine-regular: 15 configurations,
26 variants, 200 exchanges, strict request/response alternation, every response valid JSON,
`auth_session` chaining, and one check of the source itself — that **every action sent was offered
by the previous response's `next[]`**. That currently passes, so the model is internally consistent.

Two things are **derived**, and flagged as such wherever they appear:

- **HTTP status.** The source prints bodies with no status line. `authorization_code` → 200,
  `insufficient_authorization` → 403. Shown as `(derived)` in the UI.
- **`allowedIn` / `allowedOut`** on each exchange, lifted from the surrounding `next[]`.

## Files

| Path | What it is |
|---|---|
| `src/App.jsx` | Shell: one tab strip over End state / Live tenant / API Spec |
| `src/views/ConsoleView.jsx` | The transcript of request/response pairs |
| `src/views/ContractView.jsx` | The API Spec page: parameters, actions, responses, error vocabulary |
| `src/data/specMarkdown.js` | The same spec as a Markdown file, for **Export .md** |
| `src/components/ThemeToggle.jsx` | Light / dark / system |
| `src/components/ExchangeCard.jsx` | One call: editable request + its response |
| `src/components/JsonCode.jsx` | Read-only view, and the always-editable highlighted editor |
| `src/components/NextBar.jsx` | `next[]` as the gate on the following call |
| `src/components/FlowPicker.jsx` | The one dropdown |
| `src/data/flows.js` | Both content sets flattened into one catalogue, plus the picker's filters |
| `src/transports/cannedTransport.js` | Replays the modelled signup pairs |
| `src/transports/simulatorTransport.js` | Wraps `engine.js` for sign-in flows |
| `src/transports/liveTransport.js` | Real HTTP via the dev middleware |
| `src/data/conformance.js` | Checks a live response against the contract |
| `src/transports/types.js` | The one interface all three satisfy |
| `src/data/spec.js` | The contract as data: the endpoint, 25 capabilities, errors, connection presets, decisions, known gaps |
| `src/engine/engine.js` | The sign-in state machine: negotiation, `next` enforcement, session rotation, decoys |
| `scripts/vite-plugin-tenant-proxy.js` | The dev-only tenant proxy |

## Where the two models disagree

The signup and sign-in models were written separately and
describe some calls differently — signup sends `phone` where the registry declares `phone_number`,
and signup never sends `index` on `challenge:phone` although the registry marks it required (the
registry's entry is the *MFA* challenge, signup's is a just-claimed number, so they may legitimately
differ). Neither is rewritten to match the other; the divergence is computed from the data and
displayed, because an SDK has to handle what actually ships.

`status` on a capability should stay honest: `live` means verified against a real tenant, not "a
document says so".

## What was verified against a real tenant, and when

Walked against `nelson.jp.auth0.com` on 2026-09-01 with curl: initiate → `identify:email` →
`challenge:email` → `verify:otp`, plus the decoy path, the wrong-code path, and the error cases.
The response shapes in `spec.js` are copied from those real responses — including the masking
format, which is `haze******@okta****`, not the `j***e@e****e.com` the D2 RFD shows, and not the
`usxx@exxxxxx.com` the signup model shows. Three conventions, one protocol; that is why the canned
transport does not re-mask an unedited payload.

Deviations are recorded in `KNOWN_GAPS`. Two are things the tenant does that the spec does not:
`auth_session` replay is not rejected (so `challenge:email` can be replayed to re-send OTPs), and an
out-of-order action **used to** return `500` rather than `invalid_request` — re-verified
2026-09-03, the tenant now answers `400 invalid_request`, so that one is closed. Two more come from the IETF draft:
`auth_session` is not device-bound, and web-leg lifetimes never reach the client.

**Spec mode shows the end state, not current behaviour.** It does not reproduce tenant bugs — a
replayed session is refused with `invalid_session`, and an out-of-order action gets
`invalid_request` with `next` restated. The deviations above are recorded in `KNOWN_GAPS` so
they are visible without being taught as the design. Live mode is where you see what a tenant
actually does today.

The API Spec page is the wire contract only — parameters, actions, responses, error vocabulary.
`DECISIONS` and `KNOWN_GAPS` are the reasoning behind it and live in `src/data/spec.js`.

## The normative floor

`/e/authorize` implements [draft-ietf-oauth-first-party-apps-04](https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/)
(1 July 2026). Where the draft speaks it wins; the RFDs are Auth0 layered on top. Where it is
silent, it says so explicitly — *"These new error codes are specific to the authorization server's
implementation of this specification and are intentionally left out of scope."* There is no `next`
array, no action identifiers and no capability negotiation in the draft; that vocabulary is ours.

`DECISIONS` in `src/data/spec.js` records every place two documents described the same event two
ways, what was chosen, and on whose authority — `basis: 'draft'` where the draft settled it,
`basis: 'ours'` where it was a judgement call. Five so far:

| Decision | Basis | Overrides |
| --- | --- | --- |
| A paused leg resumes on the action it was offered under | ours | FORMS resumes on `form:verify:v1`, never offered; that id is retired |
| Native social posts `idp_artifact` + `idp_artifact_type` | ours | REDIR's example sends `id_token` holding an access token |
| The native form binding is `journey_id`, not `state` | ours | FORMS names it `state`; RFC 6749 already owns that word |
| Path A stays — an href can ride on the first response | ours | — (both REDIR paths kept) |
| A pause that opens a browser is `redirect_to_web` + `request_uri` | ours | REDIR used it on Path B only; BOT's examples never used it |
| No PKCE at initiate means no `request_uri` | **draft** | no document sends a `code_challenge` |

The error-code rule is a judgement call, and worth stating why. The draft's *usage* text names
these cases — *"based on a risk assessment, the introduction of a new authentication method not
supported in the application"* — while its *definition* says the request "is not able to be
fulfilled with any further direct interaction with the user", which our legs contradict by coming
back to `/e/authorize`. The draft is **silent on what follows the browser interaction**, so this
stretches an ambiguous definition rather than breaking a rule. The alternative — one continuation
code, with `href` implying the browser — was rejected because it leaves the one thing the client
must do differently unstated.

Only the PKCE rule is normative: *"the authorization server MUST NOT return a `request_uri`…"*
unless the initiate call carried a `code_challenge`. Delete `code_challenge` from the initiate
payload in the console and the `request_uri` disappears while the handoff still works.

Two consequences worth knowing. The native Forms SDK path stays `insufficient_authorization` —
it pauses the pipeline but opens no browser, so the same action id comes back under two different
error codes depending on render path. And a draft-only client consumes `request_uri` per RFC 9126
§4 by navigating to `/authorize?request_uri=…`; that works for federation, whose `href` already
is that URL, but CAPTCHA and forms resolve at `/captcha` and `/form`, so for those the actionable
instruction is the `href`. Folding every leg behind `/authorize?request_uri=…` would close the gap.
