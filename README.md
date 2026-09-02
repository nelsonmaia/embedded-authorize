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
| `npm test` | 30 assertions: data fidelity, transports, proxy allowlist + log hygiene |
| `npm run build` | Production bundle (end-state mode only — live needs the dev server) |
| `npm run extract` | Regenerate `src/data/signupPrd.generated.json` from the committed source |
| `node tests/e2e-browser.mjs` | 31 browser checks over CDP. Needs `npm run dev` running. |

## Two modes, deliberately independent

**End state** — how each flow behaves once it is fully built. Nothing leaves your browser. Two
content sets, both selected from the same dropdown:

- *Sign up* — 15 connection configurations (email / phone / both, × no / optional / required
  password) and their 26 variants, replayed from 200 modelled request/response pairs.
- *Sign in* — 14 scenarios (OTP, password, MFA, passkey, federation), **simulated**: the state
  machine in `src/engine/engine.js` runs, so a wrong OTP really fails, the attempt cap really trips,
  and an action outside `next[]` is really refused. Correct OTP is `123456`; correct password is
  `Abcd@1234`.

**Live tenant** — what a real tenant does right now, including where it is not finished.

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
works for anything new. Dark theme only; the primary is the Auth0 orange.

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
| `src/App.jsx` | Shell: End state / Live tenant, and the contract view |
| `src/views/ConsoleView.jsx` | The transcript of request/response pairs |
| `src/views/ContractView.jsx` | Browse the contract without running a flow |
| `src/components/ExchangeCard.jsx` | One call: editable request + its response |
| `src/components/JsonCode.jsx` | Read-only view, and the always-editable highlighted editor |
| `src/components/NextBar.jsx` | `next[]` as the gate on the following call |
| `src/components/FlowPicker.jsx` | The one dropdown |
| `src/data/flows.js` | Both content sets flattened into one labelled catalogue |
| `src/transports/cannedTransport.js` | Replays the modelled signup pairs |
| `src/transports/simulatorTransport.js` | Wraps `engine.js` for sign-in flows |
| `src/transports/liveTransport.js` | Real HTTP via the dev middleware |
| `src/transports/types.js` | The one interface all three satisfy |
| `src/data/spec.js` | The contract as data: 27 capabilities, errors, connection presets, known gaps |
| `src/engine/engine.js` | The sign-in state machine: negotiation, `next` enforcement, session rotation, decoys |
| `scripts/vite-plugin-tenant-proxy.js` | The dev-only tenant proxy |

## Where the two models disagree

The contract view has a section for this. The signup and sign-in models were written separately and
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

Six deviations from spec are listed in the contract view. Two matter beyond this tool:
`auth_session` replay is not rejected (so `challenge:email` can be replayed to re-send OTPs), and an
out-of-order action returns `500` rather than `invalid_request`.
