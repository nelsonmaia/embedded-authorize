# RFD: Password as first factor in Embedded Authorize

| **Status** | DRAFT |
| --- | --- |
| **Author** | @Diego Mijelshon |
| **Reviewers** | * [ ] @Alejo Fernandez * [ ] @David McKeown |
| **Informed** | @Nelson Matias |
| **Date** |  |

# Context

`POST /e/authorize` today can authenticate a user exactly one way: **email + email OTP**. The
continuation state machine in `packages/embedded-auth` implements
`action:identify:email:v1` → `action:challenge:email:v1` → `action:verify:otp:v1`, and Delivery 2
closes that loop end-to-end — the `verify:otp` success branch hands the session to a terminal resume
flow that drives the paused TDE run to a real `200 { authorization_code }`.

That is one authentication method out of the four a database connection can enable
(`options.authentication_methods`: `password`, `passkey`, `email_otp`, `phone_otp`). **Password is
the one nearly every existing tenant has enabled**, and `email_otp` is the newest and least adopted.
An embedded SDK built on `/e/authorize` therefore cannot sign in a user on the overwhelming majority
of tenants as they are configured today — not because of a policy decision, but because the
orchestrator has no handler that verifies a password.

The identifier side has the same shape of gap. `getEnabledLoginIdentifiers` returns
`email`, `username`, or `phone_number`, and negotiation maps only the first two of those onto
actions (`email` → `identify:email`, `phone_number` → `identify:phone`). There is no
`action:identify:username:v1` at all. Username has been reasonable to omit until now, because there
is no `username_otp` — a username-identified user has no OTP method to be challenged with, so
advertising the identifier would have led straight to a dead end. Adding password removes that
constraint: `username` becomes a usable identifier precisely because password is the method that can
verify it.

This RFD covers the server-side work to authenticate a user with a password in the `/e/authorize`
flow, and the `username` identifier that becomes meaningful alongside it.

# Problem Statement

`POST /e/authorize` cannot authenticate a user against the dominant database-connection
configuration.

Concretely:

- **No password verification.** A connection with `authentication_methods.password.enabled` and no `email_otp` negotiates to an empty capability intersection, so `/e/authorize` rejects the initiate call with `400 invalid_request` — "the requested connection does not support any of the capabilities declared by the client." For the tenant, embedded login simply does not work.
- **No username identifier.** A connection whose only active identifier is `username` (the classic `requires_username` shape) cannot even reach the method step: negotiation produces no `identify` action for it.
- **Consequence for consumers.** Embedded SDKs cannot ship a password login screen. Any tenant wanting to adopt embedded authorize must first reconfigure its connection to enable `email_otp` — a behavioural change for its end users — which makes the feature unadoptable for the case it most needs to serve.

The impact of not solving this is that `/e/authorize` remains a demo path for OTP-first tenants
rather than a general-purpose authorization endpoint, and every embedded SDK release is blocked on
the same missing capability.

# Proposal

Add **password as a first factor** to the `/e/authorize` continuation state machine: one new
verification action with no challenge step, plus the `username` identifier that it unlocks. Password
validation goes through the same `/wsfed/direct` call and the same Attack Protection chain that the
Universal Login password prompt uses — so credential handling, brute-force protection, and
breached-password detection behave identically in embedded and in UL — but reaches them through a
dedicated password-only path rather than UL's combined credential entry point, keeping password and
passkey separate from the start.

## In scope

| # | Item | Anchored in |
| --- | --- | --- |
| 1 | `action:identify:username:v1` — new capability, request/response schemas, and continuation handler | mirrors `identify_email.js`; gated on the `username` identifier being active |
| 2 | `action:verify:password:v1` — new capability, schemas, and handler. **Verification only** — no challenge action, no server-issued state | `verify_otp.js` as the structural reference, minus the ticket |
| 3 | Negotiation additions: `username` identifier → `identify:username`; `password` auth method → `verify:password` | `lib/capabilities/index.js` `negotiate()`, driven by `getEnabledLoginIdentifiers` / `getAuthMethodsForLogin` |
| 4 | A **password-only credential module**, extracted as a direct `postWSFedDirectAsync` call rather than reusing `usersApi.authenticate` or `AuthenticatePostHandlers.authenticate` | `postWSFedDirectAsync` in `packages/server/lib/client/auth0_users.js`; `passkeyExchangeUsersClient.js` as the structural precedent |
| 5 | Attack Protection around it, unchanged from UL: `AnomalyDetection('pwd')` → credential validation → `postLoginProtect` | `packages/server/lib/anomaly_detection/anomalyDetection.js` |
| 6 | Identifier-scoped method re-advertisement: `next` offers every method available for the identifier already established | new shared helper over `auth_request_params.capabilities`; changes the D2 handlers, which narrow `next` to one action |
| 7 | Decoy parity for the password path: uniform `invalid_identifier_or_password`, timing padding, retry re-advertising the same methods | the anti-enumeration model established for `identify`/`challenge`/`verify` in D2 |
| 8 | `error_description` vocabulary extension: `invalid_identifier_or_password` | `responses/EmbeddedAuthorizeInsufficient.json` (`const` → `enum`) |
| 9 | `amrs: ['pwd']` recorded on the success path, consumed by resume as `CompletedPrompt.performed_amr` | `buildEmbeddedLoginOutput`, which already reads `payload.amrs` |
| 10 | New handler dependencies injected through the dep bag (never imported across packages) | `embeddedAuthDeps` in `packages/server/lib/modules/registry.js`, `ContinuationHandlerDeps` |

## High-level flow
\[{"body":"sequenceDiagram\\n    autonumber\\n    participant C as SDK client\\n    participant E as POST /e/authorize\\n    participant U as auth0-users\\n    participant R as Resume + TDE\\n\\n    C-\>\>E: initiate (client\_id, connection, capabilities)\\n    Note over E: negotiate against connection config only\\n    E--\>\>C: 403 insufficient\_authorization\<br/\>next: identify email / username / phone\\n\\n    C-\>\>E: action:identify:username:v1 (username)\\n    E-\>\>U: getUser (existence check)\\n    U--\>\>E: found / not found\\n    Note over E: seal user (real) or decoy\<br/\>decoy never carries user\_id\\n    E--\>\>C: 403 insufficient\_authorization\<br/\>next: every method for this identifier\<br/\>username: verify:password only\\n\\n    C-\>\>E: action:verify:password:v1 (password)\\n\\n    alt session is a decoy\\n        Note over E: no credential I/O at all\\n        E-\>\>E: pad response time\\n        E--\>\>C: 403 invalid\_identifier\_or\_password\<br/\>next: same methods as before\\n    else real user\\n        E-\>\>U: preLoginProtect, then authenticate (username + password)\\n        U--\>\>E: identity / wrong-credentials / blocked\\n        alt authentication failed or blocked\\n            E-\>\>E: pad response time\\n            E--\>\>C: 403 invalid\_identifier\_or\_password\<br/\>next: same methods as before\\n        else authenticated\\n            E-\>\>R: resume with user\_id and amrs pwd\\n            R--\>\>E: authorization code\\n            E--\>\>C: 200 authorization\_code\\n        end\\n    end","date":1786112055252}\]

## Design decisions

### 1. Password is verification-only — there is no challenge action

OTP needs two round trips because the server must *produce* something (send a code, remember the
ticket id in `embedded_auth_state.action_state`) before the client can submit anything. Password
needs neither: the credential already exists on the client side. So `verify:password` is advertised
directly by the method step, carries no server-issued state, and its `next` descriptor carries **no
extra context** — unlike `VerifyOtpInput.json`, which advertises `channel` and `identifier` so the
client can tell the user where the code went.

A consequence worth stating: `action_state` stays empty for the password path, so nothing
password-related is sealed into the `auth_session` — *unless* we decide to track attempts
(Open Questions 1–3), which is the one thing that would put a field there. That would also require
relaxing the payload schema's conditional, which today asserts `action_state.attempts` may only be
present on a decoy session.

Either way **the password itself is never written to session state** — it lives only for the
duration of the single request that verifies it.

### 2. Method advertisement is derived from connection configuration, never from user data

This is the existing invariant, and password does not get to weaken it. At the point the server
advertises methods, the session may be a decoy: the user may not exist. Advertising "this user has a
password" would be an enumeration oracle. So `verify:password` is advertised whenever
`getAuthMethodsForLogin(connection)` includes `password` — for real users and decoys alike, with a
byte-identical response.

**Decision: embedded advertises the full negotiated method set and lets the client choose.** This is
a deliberate divergence from Universal Login, which resolves a single default method per identifier
via `AuthenticationMethodsHandler.getDefaultMethodForIdentifier` (precedence
`email: ['password','email_otp']`, `phone_number: ['password','phone_otp']`, `username: ['password']`). Two reasons to diverge: an SDK is not a UI with one visible button, so it needs the
whole set to render its own choice; and client-driven method switching (Design decision 8) only
works if more than one method is visible at a time. The consequence is a visible behavioural
difference from UL for the same connection configuration, accepted.

### 3. Extract a password-only credential path — do not reuse the UL entry points

We do **not** call `usersApi.authenticate` or `AuthenticatePostHandlers.authenticate` from the
embedded handler. Both are UL orchestration: they take a combined `{ username, password, passkey }`
context, branch internally on which credential is present, assemble `passkeyContext`, resolve
`performed_amr` per credential type, and raise `PromptSubmissionError` with prompt-shaped error
lists. Password and passkey want **different paths** in embedded — and passkey is out of scope for
this RFD — so reusing a combined entry point would mean inheriting a branch we do not want and an
error contract we cannot use.

Instead we extract the part that actually validates a password: the `postWSFedDirectAsync` call.
That function (`packages/server/lib/client/auth0_users.js`) is already credential-agnostic — the
password, passwordless, passkey, and Lock paths all call it — so the extraction happens *above* it,
at the level `usersApi.authenticate` sits at, not inside it.

The new password-only module:

- calls `postWSFedDirectAsync` with password-shaped params only (no `passkey`, no `passkeyContext`)
- maps the returned profile via `auth0Mapper.mapOriginalProfileToAuth0Profile`
- returns `{ identity, identifierType }`, or a result object for the failure cases

The precedent is exact: `packages/server/lib/auth/protocols/oauth2/passkey/passkeyExchangeUsersClient.js`
already does this for passkey in the OAuth2 exchange — a credential-specific client over
`postWSFedDirectAsync` with its own error mapping, sitting alongside `usersApi.authenticate` rather
than replacing it. `usersApi.authenticate` is left untouched, so UL's password and passkey paths
carry no regression risk. The cost is that profile-mapping logic exists in two places.

Around that module, the handler performs the same Attack Protection sequence UL does — this part
*is* reused as-is:

1. `new AnomalyDetection(reqContext, authContext, { username, password, connection }, 'pwd')`
2. `await anomalyDetection.preLoginProtect()` — suspicious-IP throttling, single-user brute force, same-user-login; returns `{ onAuthenticationSuccess, onAuthenticationFailed }`
3. `await validatePassword({ username, password, tenant, databaseConnection, clientId, ... }, reqContext)` → `{ identity, identifierType }` — the new module
4. `anomalyDetection.setIdentifierType(identifierType)`; `await anomalyDetection.postLoginProtect()` — breached-password detection
5. `await results.onAuthenticationSuccess()`, or `onAuthenticationFailed()` on the failure branch

Because step 3 still goes through `/wsfed/direct`, credential semantics are identical to UL for
Auth0 DB, custom DB scripts, and imported connections; and because steps 1–2 and 4–5 are the
untouched `AnomalyDetection` chain, brute-force counters, lockouts, and breached-password behaviour
are identical too. What is embedded-specific is only the orchestration and the error contract.

Two integration constraints follow, and both are real work:

- **Injection, not import.** The new module and `AnomalyDetection` live in `packages/server`, and `packages/embedded-auth` must not require the consuming application. Both must be added to `embeddedAuthDeps` and threaded through `ContinuationHandlerDeps` — exactly as `usersClient`, `maskEmail`, `padResponseTime`, and `isValidEmail` already are.
- **The handler needs the full connection object.** The credential call takes `databaseConnection` (it reads `.name`, `.strategy`, `.options`), and `AnomalyDetection` reads `options.brute_force_protection` and `options.attributes`. The continuation path seals only the connection *name* in `auth_request_params`, so the handler must re-load the connection via `getConnectionByNameCached` — the same thing the resume flow already does. That is a new handler dependency.

### 4. One uniform failure response for every negative outcome

Wrong password, non-existent user (decoy), blocked user, blocked IP, breached password, and a custom
DB script's rejection all produce the **same** recoverable response:

```json
{
  "error": "insufficient_authorization",
  "error_description": "invalid_identifier_or_password",
  "next": [{ "action": "action:verify:password:v1" }],
  "auth_session": "<rotated>"
}
```

at `403`, with `next` re-advertising the same methods the client already had. This mirrors
`invalid_identifier_or_code` on the OTP path, and the naming deliberately keeps the
identifier-or-secret ambiguity: the client cannot learn *which* half was wrong.

Collapsing the Attack Protection outcomes into this response is a deliberate loss of fidelity — see
Open Question 4. `user-blocked` and `password-breached` are true statements about a specific
existing account, so surfacing them faithfully would confirm the account exists.

### 5. Timing padding gets its own constant, `PASSWORD_VERIFY_MIN_RESPONSE_TIME_MS`

The decoy branch performs no credential I/O, so it returns in microseconds while the real branch
makes a network call to auth0-users. Without padding, latency alone distinguishes them. So the
handler wraps both branches in `padResponseTime(startTime, minMs)`, exactly as `verify_otp` does.

**Decision: a new constant, **`PASSWORD_VERIFY_MIN_RESPONSE_TIME_MS`**, rather than reusing
**`OTP_CHALLENGE_MIN_RESPONSE_TIME_MS`**.** It starts at the same `1s`, so there is no behavioural
difference on day one — the point is that the password floor becomes independently tunable.

That matters because the two paths are sized differently. `1s` comfortably exceeds the OTP-ticket
validation the OTP constant was sized for. Password validation goes through `/wsfed/direct` and, for
custom DB connections, runs a customer-authored login script inside the sandbox — routinely slower
than 1s. When the real branch exceeds the floor, padding becomes a no-op and the latency oracle
returns. A separate knob means we can raise the password floor from measured p99 data without
paying for it on every OTP challenge, and without a second migration to split the constant later.

### 6. `verify:password` is the first handler to populate `amrs`

`amrs` is initialised `[]` at initiate and left untouched by every handler today; Delivery 2
explicitly deferred AMR population, so `verify:otp` completes with `amrs: []`. The resume flow
already consumes whatever is there — `buildEmbeddedLoginOutput({ user, connectionRecord, amrs })`
passes it to `CompletedPrompt({ performed_amr: amrs })`.

The password success path sets `amrs: ['pwd']` on the payload it hands to resume, matching what UL
records for a password login.

**Decision: always emit, not gated behind **`add_pwd_amr_idtoken_claim`**.** UL only sets
`performed_amr = ['pwd']` when that flag is on for the tenant, but embedded is new surface with no
legacy tokens to preserve, and inheriting a rollout gate into a greenfield path would mean carrying
it indefinitely. The accepted consequence: on a flag-off tenant, the same user logging in through UL
and through embedded gets different `amr` claims until the flag finishes rolling out.

### 7. `username` identifier gating

`action:identify:username:v1` is advertised when `getEnabledLoginIdentifiers(connection)` includes
`username`. The handler mirrors `identify_email.js` — validate format, resolve existence via
`usersClient.getUserAsync`, seal a real-or-decoy user, respond uniformly — with `isValidUsername` /
`getUsernameValidationOptions` in place of `isValidEmail`, since username validity is
connection-configured (min/max length, allowed characters, lenient mode for custom DB).

There is a potential overlap: `attributes.username.validation.allowed_types` can allow email-shaped
and phone-shaped usernames, so with both `email` and `username` active, one submitted value can be
legitimately valid for two different identify actions.

**Decision: **`identify:email`** and **`identify:username`** are separate paths, and the client picks.** The
server trusts the action it was given and looks the value up as that identifier type — it does not
normalise the submitted value to a canonical type or second-guess the choice. How the client decides
is the client's business: it may detect that the input is email-shaped and default to
`identify:email`, or let the end user choose. This keeps each action's lookup semantics simple and
predictable, at the cost that the same input submitted under two different actions can legitimately
resolve to two different results.

### 8. `next` re-advertises every method available for the identifier already established

Method switching is not a separate feature and needs no "switch" command. It falls out of computing
`next` correctly: if a connection enables both `password` and `email_otp` and the user identified by
email, then `verify:password` and `challenge:email` are **both** in `next` — at the method step, and
again after a failed password attempt, and after a failed OTP attempt. The client or SDK decides
which to use. Re-initiating is not required.

Availability is scoped by the **identifier already used**, not merely by the connection:

| Identifier established | Methods offered in `next` (subject to connection config) |
| --- | --- |
| `username` | `verify:password` only — there is no `username_otp`, so no OTP challenge applies |
| `email` | `verify:password`, `challenge:email` |
| `phone_number` | `verify:password`, `challenge:phone` *(when that handler exists — see Non-Goals)* |

The rule: **if **`password`** is enabled on the connection, every identifier can reach
**`verify:password`; OTP challenges are only available for the same identifier the user actually
identified with. This is a per-session generalisation of the gate `negotiate()` already applies
per-connection at initiate, where `challenge:email` is only added if the `email` identifier is
active.

This is new work, not existing behaviour. The D2 handlers narrow `next` to a single action at every
step — identify-success sets `['action:challenge:email:v1']`, and a failed `verify:otp` re-advertises
only `['action:verify:otp:v1']`. So this introduces a shared helper that re-intersects the negotiated
capability set (sealed in `auth_request_params.capabilities`) with the identifier-scoped method set,
and applies it in the identify handlers and on every recoverable verify failure. Applying it
symmetrically to `verify:otp` as well as `verify:password` is deliberate: switching must work in both
directions, or an OTP-first client is stuck where a password-first client is not.

## Capability and schema additions

Two capability ids, added to the single `SUPPORTED_CAPABILITIES` set in
`lib/capabilities/index.js`. That set also feeds the `auth_session` payload schema's
`capabilityEnum`, so it simultaneously constrains `auth_request_params.capabilities` and
`embedded_auth_state.next`:

- `action:identify:username:v1`
- `action:verify:password:v1`

Four new OpenAPI schema files under
`packages/server/lib/schemas/embedded-authorize/schemas/actions/`, following the existing
request/`...Input` pairing:

```json
// IdentifyUsername.json — the request body
{
  "title": "action:identify:username:v1",
  "type": "object",
  "required": ["auth_session", "action", "username"],
  "properties": {
    "auth_session": { "$ref": "../EmbeddedAuthorizeAuthSession.json" },
    "action": { "type": "string", "const": "action:identify:username:v1" },
    "username": { "type": "string", "minLength": 1, "description": "Username." }
  },
  "additionalProperties": false
}
```

```json
// VerifyPassword.json — the request body
{
  "title": "action:verify:password:v1",
  "type": "object",
  "required": ["auth_session", "action", "password"],
  "properties": {
    "auth_session": { "$ref": "../EmbeddedAuthorizeAuthSession.json" },
    "action": { "type": "string", "const": "action:verify:password:v1" },
    "password": { "type": "string", "minLength": 1, "description": "User password." }
  },
  "additionalProperties": false
}
```

```json
// VerifyPasswordInput.json — the advertised `next` entry. No extra context by design.
{
  "title": "action:verify:password:v1",
  "type": "object",
  "required": ["action"],
  "properties": {
    "action": { "type": "string", "const": "action:verify:password:v1" }
  },
  "additionalProperties": false
}
```

`IdentifyUsernameInput.json` is the same shape as `IdentifyEmailInput.json` — `action` only. Both
pairs must be registered in the `oneOf` of `requestBodies/EmbeddedAuthorizeContinue.json` and
`schemas/EmbeddedAuthorizeNextAction.json`.

One existing schema relaxation:

```json
// EmbeddedAuthorizeInsufficient.json — `error_description` becomes an enum
"error_description": {
  "type": "string",
  "enum": ["invalid_identifier_or_code", "invalid_identifier_or_password"]
}
```

`responses/EmbeddedAuthorizeAccessDenied.json` needs a new terminal `error_description` value **only
if** a session-scoped attempt cap is adopted for password (Open Questions 1–3). The recommendation
there is that it is not, so no change.

## Cross-cutting concerns

**Security — enumeration.** The password path inherits the full D2 model: uniform response bodies,
timing padding, and the decoy invariant that a decoy session never carries a `user_id` (enforced both
imperatively in `buildUser` and declaratively in the payload schema, `if decoy: true then not required: [user_id]`). The new surface it introduces is the credential itself, which is why
Open Questions 4 and 5 both concern residual side channels rather than the response body.

**Security — credential handling.** The password appears in the request body, is passed to the
password-only credential module and to `AnomalyDetection` (which needs it for breached-password
detection), and is discarded. It is never sealed into `auth_session`, never logged, and never echoed. Structured
logs on this path (`log_type: embedded_authorize_verify`) carry `tenant`, `client_id`, `connection`,
`decoy`, and a `result` discriminator — no identifier, no credential.

**Observability.** `result` values mirror the OTP handler's vocabulary so the two paths can be
compared in log search: `success`, `wrong_password`, `decoy_wrong_password`, `blocked`. Attack
Protection's own `logOnResponse.attackProtection` output (BFP key, max attempts, remaining attempts)
comes along for free once `AnomalyDetection` is wired in, matching UL.

**Reliability.** A `5xx` from auth0-users is a dependency outage, not a credential failure, and must
surface as a masked `500 server_error` rather than being folded into
`invalid_identifier_or_password` — otherwise an outage looks like a wrong password and clients will
retry into it. `AnomalyDetection` failures that are not blocks surface as
`anomaly-detection-failure`; the RFD assumes the UL treatment (fail closed on blocks, propagate
otherwise).

**Rate limits.** `/e/authorize` runs under `limitByTenant.oauthApi()`. Password verification is a
credential-guessing surface, so whether it belongs in the shared OAuth bucket is the same open
question D2 raised for the challenge action, now with more weight behind it.

**Cost.** No new infrastructure. One additional auth0-users call per verification attempt, plus the
Attack Protection reads/writes that UL already performs per login.

## Non-Goals

- **Password signup / registration** — creating a user with a password via `/e/authorize`. Login only.
- **Password reset / forgot-password** — no reset ticket issuance or redemption in this flow.
- **Post-authentication password interstitials** — `must-change-password`, expired password, and password-policy upgrade prompts. UL handles these with prompt navigation, for which the embedded contract has no equivalent yet; a connection requiring one of these will fail the verification rather than negotiating an interstitial.
- **Passkeys** (`authentication_methods.passkey`) — a separate method with a challenge step of its own.
- **MFA / second factors** — password as a *first* factor only. Multi-factor sequencing is a separate delivery.
- `action:identify:phone:v1` **handler** — the capability is negotiated today but has no registered handler, so it resolves to `501 not_implemented`. That gap predates this proposal and is not addressed here. Note the consequence: on a connection whose only active identifier is `phone_number`, password login remains unreachable until that handler lands.
- **A dedicated "switch method" command** — no embedded equivalent of UL's `FlowsAndPromptsEnum.SWITCH_TO_OTP_AUTH` is needed. Switching is not a server action: every method available for the established identifier is always present in `next`, so the client simply submits a different one (Design decision 8).
- **OTP resend / re-challenge** — already deferred, unchanged by this proposal.

## Open Questions

1. **Do we track a max-attempts cap for password verification?** — The OTP path hard-codes `MAX_OTP_ATTEMPTS = 5` in `verify_otp.js`, and its own comment is explicit that this is a hand-maintained mirror of a cap the users service enforces, with no shared config. It is used *only* on the decoy branch, because the decoy performs no I/O and therefore gets no cap from the service. Password has no analogous users-service per-session cap at all — the real-user backstop is Attack Protection, which counts per tenant/user/IP across all flows, is configurable per connection (`options.brute_force_protection`) and per tenant trigger, and can be switched off entirely. *Recommendation:* do **not** invent an embedded-only session cap for real users. Attack Protection is the product's answer to password guessing, it is shared with UL and the token endpoints, and duplicating it in the orchestrator would produce two disagreeing limits with the weaker one invisible to tenant configuration.
2. **Does this match what we do for OTP?** — Not symmetrically, and the recommendation is that it should not pretend to. For OTP the users service supplies the real-user cap and the handler mirrors it for decoys; for password there is nothing to mirror. But leaving the decoy branch entirely uncapped creates its own oracle: a real account eventually trips brute-force protection and starts failing differently, while a decoy could be retried forever. *Recommendation:* keep a decoy-side counter whose only purpose is to make the decoy stop looking *more* permissive than a real account. Its threshold should be derived from the connection's configured brute-force threshold rather than a fresh hard-coded constant — and if that derivation proves impractical, the fallback question is whether a fixed decoy cap is better or worse than none. This is the single point in the design where reviewer input is most valuable.
3. **Do we need to track attempts for non-decoy users in this case?** — Today the payload schema actively *forbids* it: a conditional asserts `action_state.attempts` may only be present when `user.decoy === true`. Tracking real-user attempts would mean relaxing that conditional. *Recommendation:* no. Attack Protection already counts real attempts, durably and across sessions, whereas a session-scoped counter is trivially reset by re-initiating — so it would add schema complexity and a false sense of a limit without bounding an attacker. Keep the schema conditional as-is; it is a useful guard that the decoy counter cannot leak into real sessions.
4. **How do Attack Protection outcomes map onto the error vocabulary?** — `user-blocked` and `password-breached` are terminal and specific to an existing account; `ip-blocked` and `same-user-login` are terminal but not account-specific. Folding all four into the recoverable `invalid_identifier_or_password` is safest but tells a legitimately-blocked user nothing and invites them to keep retrying against a lockout. Do we add a terminal `access_denied` code for the non-account-specific ones (`ip-blocked`, `same-user-login`) while masking the account-specific ones, or mask uniformly?
5. **Do we want to support custom error messages for custom DB connections?** — This is a product decision, and it cuts against the enumeration model. The credential call surfaces `custom-script-error` carrying `info.message`, which for a custom DB connection is **customer-authored text**; UL has an explicit mitigation (`isGenericCustomDBErrorsEnabled`) precisely because such a message can distinguish "no such user" from "wrong password". The safe default, and what this RFD assumes unless decided otherwise, is that embedded never forwards these messages or the error code derived from them (`custom-script-error-code_<code>`): every custom-script rejection maps to the generic `invalid_identifier_or_password`, and the underlying code is logged rather than returned. But tenants with custom DB scripts do write those messages deliberately and may expect them to reach the end user. If we want to support them, we need a decision on how — an opt-in per connection, mirroring UL's flag? only for messages the tenant asserts are enumeration-safe? — because forwarding them unconditionally hands an attacker exactly the oracle the rest of this design removes.

## Resources

- **Delivery 2 RFD (direct predecessor, establishes the anti-enumeration and resume model):** [RFD: Embedded Authorize — Delivery 2 ("Complete the login": Email OTP)](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/973309677/RFD+Embedded+Authorize+Delivery+2+Complete+the+login+Email+OTP)
- **Delivery 2 implementation (unmerged at time of writing — the resume path and the** `verify:otp` **success contract this RFD builds on):** <https://github.com/atko-cic/auth0-server/pull/19115>
- **Package overview:** `packages/embedded-auth/README.md`
- **Key code anchors (auth0-server):**
    - `packages/embedded-auth/lib/capabilities/index.js` — `SUPPORTED_CAPABILITIES`, `negotiate()`
    - `packages/embedded-auth/lib/orchestrator/Orchestrator.js` — allow-list enforcement + dispatch; `lib/orchestrator/handlers/{index.js,identify_email.js,challenge_email.js,verify_otp.js}`
    - `packages/embedded-auth/lib/session/{schema.js,embedded_auth_state.js}` — payload schema (`capabilityEnum`, decoy and `attempts` conditionals), `buildUser`, `advanceEmbeddedAuthState`
    - `packages/server/lib/schemas/embedded-authorize/` — `schemas/actions/*`, `requestBodies/EmbeddedAuthorizeContinue.json`, `responses/*`
    - Connection configuration: `packages/server/lib/prompts/model/connections.js` (`getEnabledLoginIdentifiers`, `getAuthMethodsForLogin`, `isEmailAllowedInUsername`), `packages/server/lib/prompts/model/authentication_methods.js` (`AuthenticationMethodsHandler.getDefaultMethodForIdentifier`)
    - UL password path (the reference, *not* the reuse target — see Design decision 3): `packages/authentication-factors/lib/flows/universal_login/prompts/authenticate/password.js`, `.../authenticate/handlers/post.js` (`authenticate()`), `.../authenticate/helpers/errors.js`
    - Credential validation: `postWSFedDirectAsync` in `packages/server/lib/client/auth0_users.js` (the extraction point); `packages/server/lib/prompts/registry/helpers/usersApi.js` (`authenticate()`, the UL wrapper left untouched); `packages/server/lib/auth/protocols/oauth2/passkey/passkeyExchangeUsersClient.js` (structural precedent for a credential-specific client)
    - Attack protection: `packages/server/lib/anomaly_detection/{anomalyDetection.js,single_user_brute_force.js}`
    - Timing padding: `packages/server/lib/auth/otp/response_time_padding.js`; `OTP_CHALLENGE_MIN_RESPONSE_TIME_MS` in `packages/server/lib/config/schemas/auth.js`, where the new `PASSWORD_VERIFY_MIN_RESPONSE_TIME_MS` sits alongside it
    - Dependency injection: `packages/server/lib/modules/registry.js` (`embeddedAuthDeps`), `packages/types/types/packages/Embedded.ts` (`ContinuationHandlerDeps`)
