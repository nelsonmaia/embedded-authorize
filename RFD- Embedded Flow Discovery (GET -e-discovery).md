# RFD: Embedded Flow Discovery \(GET /e/discovery\)

| **Status** | DRAFT |
| --- | --- |
| **Author** | @Diego Mijelshon |
| **Reviewers** | * [x] @Alejo Fernandez * [x] @David McKeown |
| **Informed** |  |
| **Date** |  |

In scope: a new JSON endpoint that returns the **grant types** a given client can use — including the **embedded authorize flow** at `POST /e/authorize`, advertised as an `authorization_code` alternative — derived from the client's enabled grants, its enabled connections, and each connection's configured authentication methods; filtering by an optional `connection`; and a new `embedded_discovery` feature flag plus a new per-client `embedded_discovery` setting that together govern access. The per-client `embedded_authorize` property is **read** as an inclusion condition but is **defined elsewhere**. Out: organizations, MFA, enrollment/signup discovery, and any change to the grants themselves.

# Context

Auth0 is building **embedded authentication** — headless, JSON-only authentication driven by a native or SPA application without redirecting to Universal Login. Milestone 1 delivers the interactive half of that story at `POST /e/authorize`.

Alongside that interactive flow, a tenant may have a range of **direct grants** enabled at `POST /oauth/token`: ROPG (`password`, `http://auth0.com/oauth/grant-type/password-realm`), passwordless OTP (`http://auth0.com/oauth/grant-type/passwordless/otp`), passkeys (`urn:okta:params:oauth:grant-type:webauthn`), and native social login via token exchange (`urn:ietf:params:oauth:grant-type:token-exchange`). Whether any given one is usable is not a property of the SDK — it is a product of tenant and client configuration spread across at least four places:

- the client's `grantTypes` array (`hasGrantType`, `packages/server/lib/auth/client/client_service.js:154`);
- the set of connections enabled for that client (`packages/server/lib/db/connections.js`);
- each connection's `strategy` and its `options.authentication_methods.<method>.enabled` map, surfaced by `getAuthMethodsForLogin` (`packages/server/lib/prompts/model/connections.js:730`);
- tenant-level settings such as `tenant.default_directory`, plus per-feature flags.

Today none of this is readable by the application that has to build the login screen.

# Problem Statement

**The problem is not one missing endpoint. It is that the plan to make embedded authentication cheap to adopt is running behind, and the API-first route we are on is unlikely to close the gap in time.**

The program's goal, with `POST /e/authorize` underway, is a production-ready session and orchestration story **this fiscal year**, cutting the complexity and cost a customer absorbs to build embedded login. The date is not arbitrary — it tracks live opportunity timelines in a market that is accelerating, where sustained momentum counts for as much as the eventual feature set. The bar for success is concrete: a customer integrates an embedded solution in **hours, not days or weeks**, and is left free to work on end-user conversion and retention instead of on plumbing.

The current roadmap is unlikely to clear that bar. Its critical path runs through a standards-aligned orchestration capability that demands substantial work in core services, and the projected end of that path is **likely beyond Q2 FY28**. Confidence in delivering even to that extended date is **low**. The risk is therefore not just late arrival; it is that the plan we would be waiting on may not hold.

Meanwhile, **18 months** of investment in the existing APIs and services has produced a materially better embedded experience, and those changes are seeing real adoption and use. But they are built on a **"zoo" of endpoints** — `/oauth/token` grants, `/passwordless/start`, `/otp/challenge` — and rationalising that sprawl is precisely the work the roadmap deferred in the name of faster adoption. So the integration cost the program set out to remove is still being paid by every customer, while the work that would remove it is the work most at risk.

Hence the direction this RFD works within: **lead with developer experience in the SDKs rather than with API redesign.** The logic that composes a coherent journey across several endpoints belongs in the SDKs, and the API surface moves only as far as needed to support that SDK-led experience — reusing the APIs that already exist and making narrow, targeted additions for specific application journeys.

That direction places a demand on the API surface that is not currently met. **An SDK cannot compose a journey it cannot see.** To assemble login on the application's behalf, an SDK has to know which grants the client may actually use — and today it must either hardcode the tenant's configuration at build time or discover it by trial and error against `POST /oauth/token`. Four concrete consequences:

1. **Configuration is compiled into the app.** "This tenant uses Email OTP on connection `my-db`" becomes a constant in a mobile binary. A tenant admin enabling passkeys, adding a database connection, or turning off ROPG cannot take effect until the app is rebuilt and re-shipped through an app store — a change the admin believes is a dashboard toggle is in reality a release cycle.
2. **The alternative is probing with real user input.** Absent discovery, the only way to learn that a grant is unavailable is to call it and read the error. That burns a round trip, surfaces errors that are indistinguishable from genuine credential failures, and needs a real identifier to even attempt.
3. **Login UI cannot be assembled correctly.** Rendering "Sign in with Google", a passkey button, or an "email me a code" option requires knowing, respectively, whether `native_social_login.google.enabled` is set, whether any client-enabled connection has `passkey` in its authentication methods, and whether one has `email_otp`. All three are server-side facts.
4. **Each grant is addressed differently, and the differences are invisible.** Passwordless OTP is the clearest case: a legacy `email`/`sms`-strategy connection and an `auth0`-strategy connection with `email_otp` enabled share one `grant_type` string but need **different challenge endpoints and mutually exclusive token parameters** (see Discovery). A client cannot pick the right call sequence from the grant type alone.

The gap compounds with every capability added to the embedded surface: each new factor becomes another constant hardcoded in every SDK. That is the opposite of an SDK-led strategy, in which the SDK reads configuration rather than shipping assumptions about it.

# Proposal

`/e/discovery` is the kind of narrow addition that direction calls for: a single read-only endpoint that lets an SDK see which grants a client may use, so it can compose the journey from grants that already exist instead of waiting for them to be redesigned.

Add `GET /e/discovery` to `@a0-srv/embedded-auth`, registered alongside `/e/authorize` — the same registration table and the same middleware chain, but with its own feature flag and its own caching — returning the grant types a client can use.

Requests carry `client_id` and an optional `connection` name — nothing else. The response depends only on tenant, client, and connection configuration, never on anything the caller declares about itself. Responses carry a single `alternatives` array, where each element describes one usable way to authenticate, keyed by `grant_type`.

```text
GET /e/discovery?client_id=abc123
```

```json
{
  "alternatives": [
    {
      "grant_type": "authorization_code",
      "type": "embedded_authorize",
      "connection": "my-db"
    },
    {
      "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
      "subject_token_type": "http://auth0.com/oauth/token-type/google-id-token"
    },
    {
      "grant_type": "password"
    },
    {
      "grant_type": "urn:okta:params:oauth:grant-type:webauthn",
      "connection": "my-db"
    },
    {
      "grant_type": "http://auth0.com/oauth/grant-type/passwordless/otp",
      "type": "legacy",
      "connection": "email",
      "identifier_types": ["email"]
    },
    {
      "grant_type": "http://auth0.com/oauth/grant-type/passwordless/otp",
      "type": "auth0",
      "connection": "my-db",
      "identifier_types": ["email", "phone_number"]
    },
    {
      "grant_type": "http://auth0.com/oauth/grant-type/password-realm",
      "realm": "Username-Password-Authentication"
    }
  ]
}
```

## Grant types returned

Each element of `alternatives` names a **grant type** the client redeems at `POST /oauth/token`, carrying only the extra properties that grant needs — including those needed by a step that must precede the redemption, such as a challenge or `POST /e/authorize`.

| `grant_type` | Extra properties |
| --- | --- |
| `authorization_code` | `type`, `connection` |
| `urn:ietf:params:oauth:grant-type:token-exchange` | `subject_token_type` |
| `password` | — |
| `urn:okta:params:oauth:grant-type:webauthn` | `connection` |
| `http://auth0.com/oauth/grant-type/passwordless/otp` | `type`, `connection`, `identifier_types` |
| `http://auth0.com/oauth/grant-type/password-realm` | `realm` (in practice, it is *almost* the same as `connection`) |

> **More grant types will be added; details TBD.** The list above is the initial cut. The set is designed to be open — each future grant type adds inclusion rules and, where needed, its own extra properties, without changing the envelope.

### Inclusion rules

`authorization_code` — the **embedded authorize flow**. Emit **one element per connection with** `strategy: auth0` enabled for the client, when *all* hold:

- the client's `embedded_authorize` property is `true`;
- the `andromeda` feature flag is enabled for the tenant — the same flag that enables `POST /e/authorize` (`packages/server/lib/config/schemas/belgrano.js:2171`);
- `authorization_code` is in the client's `grantTypes` — the code is redeemed at `POST /oauth/token`, where `validateClientGrants` applies (decision #8).

`connection` is the connection name; `type` is `embedded_authorize`. Like the OTP flags, `andromeda` is read in the handler through the same injected `checkAccessSync` that backs the route's flag gate (decision #1), not as middleware: it suppresses **one alternative**, not the endpoint. A tenant without `andromeda` still gets a `200` carrying every other alternative it qualifies for.

**Discovery is deliberately narrower than the endpoint on both counts.** `POST /e/authorize` itself checks neither the client's `grantTypes` nor the connection's strategy. Advertising only `auth0`-strategy connections, and only to clients holding the grant, keeps the payload to what an SDK can actually carry through to a successful token exchange — the standard decision #8 sets.

The per-client `embedded_authorize` property does **not yet exist on the client record**; it is owned outside this RFD (see Non-Goals).

Both password grants answer one question — **is this connection password-capable for this client** — and the answer is strategy-dependent. `POST /oauth/token` accepts eight strategies (`ALLOWED_STRATEGIES`, `packages/server/lib/auth/protocols/oauth2/exchange/password.js:69-78`, enforced at `:981`; `password-realm` shares the check by delegating to `exchangePassword`, `password-realm.js:67`). Discovery advertises four of them:

| Strategy | Additional condition |
| --- | --- |
| `auth0` | `getAuthMethodsForLogin(connection)` includes `password` |
| `ad` | — |
| `adfs` | — |
| `waad` | `options.identity_api` is `azure-active-directory-v1.0` or absent — i.e. **not** `microsoft-identity-platform-v2.0` |

`getAuthMethodsForLogin` **is checked for** `auth0` **only.** It is a `DatabaseConnection` projection over `options.authentication_methods` (`packages/server/lib/prompts/model/connections.js:734`), and that class applies defaults when the field is absent — so it reports `password` for an enterprise connection that has no `authentication_methods` at all. Checking it there is not redundant, it is wrong: an enterprise connection carrying an explicit `authentication_methods.password.enabled = false` would be dropped from discovery while `/oauth/token` still accepts it. For `ad`, `adfs` and `waad`, allowlist membership is the condition.

**waad is v1-only, and the gate is a strategy capability rather than a field comparison.** `WaadStrategyFactory.__getStrategy` routes to `IdentityPlatformStrategyFactory` when `identity_api === 'microsoft-identity-platform-v2.0'` and to `AzureADStrategyFactory` otherwise (`packages/user-authentication-strategies/lib/strategies/microsoft/WaadStrategyFactory/index.js:26-32`); only `AzureADStrategyFactory` defines `authenticateWithUsernamePassword` (`AzureADStrategyFactory.js:401`), and the authenticate middleware rejects the grant with *"specified strategy does not support requested operation"* when that method is missing (`packages/user-authentication-strategies/lib/middlewares/authenticate.js:252-259`). Because the routing tests `!== v2.0`, a legacy waad connection with **no** `identity_api` **field** gets the v1 strategy and does support ROPG — so the discovery condition is stated as "not v2.0", not "equals v1.0". Stating it the other way would under-advertise every waad connection predating the field.

**The other four allowlisted strategies are not advertised.** `email` and `sms` are passwordless — their presence in the password allowlist is legacy, and `password-realm` rejects those realms outright (`password-realm.js:28-35`). `google-apps` password authentication was shut down by Google. `mock` is test-only.

`password` — emit a single element when *all* hold:

- `password` is in the client's `grantTypes`;
- `tenant.default_directory` is set;
- the default-directory connection resolves for this client (decision #8) **and** is password-capable per the table above;
- if the request specified `connection`, it equals `tenant.default_directory`.

`password-realm` — when `http://auth0.com/oauth/grant-type/password-realm` is in the client's `grantTypes`, emit **one element per password-capable connection** enabled for the client, per the table above. `realm` is the connection name.

`passwordless/otp` — when `http://auth0.com/oauth/grant-type/passwordless/otp` is in the client's `grantTypes`, a connection qualifies under either scenario:

| Scenario | `type` | `identifier_types` |
| --- | --- | --- |
| Legacy passwordless: `email` or `sms` strategy | `legacy` | `["email"]` or `["phone_number"]` per strategy |
| `auth0` strategy with `email_otp`/`phone_otp` in `getAuthMethodsForLogin` | `auth0` | one or two of `["email", "phone_number"]` per enabled method |

`type: auth0` **carries two additional tenant feature-flag conditions.** It is emitted only when **both** `allow_otp_database_connection_auth_api` **and** `allow_otp_database_connection_config` are enabled for the tenant (declared in `packages/server/lib/config/schemas/belgrano.js:2098,2102`, both default off). The two are read in different places in the flow, and discovery must require both because the flow needs both:

- **Challenge** — `allow_otp_database_connection_auth_api` alone gates `POST /otp/challenge`, as route middleware (`packages/authentication-factors/lib/otp_auth_api/handlers/featureFlagVerifier.js:13`). With it off, the challenge is `endpoint_disabled` and the SDK never obtains an `auth_session`.
- **Exchange** — `POST /oauth/token` requires **both** flags together (`packages/server/lib/auth/protocols/oauth2/exchange/passwordless-otp.js:209-213`): the `auth_session` branch is entered only when both `checkAccessSync` calls pass, so `allow_otp_database_connection_config` is never sufficient on its own, and neither flag is checked in only one of the two steps.

Requiring both is not defensive duplication — either flag being off breaks the DB-connection OTP path, and it breaks it in a way an SDK cannot interpret. When the `auth_session` branch is skipped, the exchange falls through to the legacy realm branch and answers a well-formed `auth_session` call with `Missing required parameter: realm` — an error naming a parameter the `type: auth0` contract explicitly forbids the caller from sending (see Discovery). Advertising `type: auth0` for such a tenant would hand the SDK a grant that fails with a misdirecting error, which is exactly what decision #8 forbids.

Both flags are read in the handler through the same injected `checkAccessSync` that backs the route's flag gate (decision #1), not as middleware: they suppress **one alternative**, not the endpoint. A tenant with the flags off and legacy passwordless connections still gets a `200` with its `type: legacy` alternatives.

`type: legacy` carries no flag condition — nothing gates the legacy passwordless path, so a qualifying `email`/`sms` connection is emitted on strategy and grant alone.

`webauthn` — when `urn:okta:params:oauth:grant-type:webauthn` is in the client's `grantTypes`, emit one element per client-enabled connection whose `getAuthMethodsForLogin` includes `passkey`. Carries `connection`.

**Native social** (`token-exchange`) — requires the provider's own flag. Emit one element per enabled provider, all with `grant_type: urn:ietf:params:oauth:grant-type:token-exchange`, distinguished by the *value* of `subject_token_type`:

| Provider | Client flag | `subject_token_type` |
| --- | --- | --- |
| Google | `native_social_login.google.enabled` | `http://auth0.com/oauth/token-type/google-id-token` |
| Apple | `native_social_login.apple.enabled` | `http://auth0.com/oauth/token-type/apple-authz-code` |
| Facebook | `native_social_login.facebook.enabled` | `http://auth0.com/oauth/token-type/facebook-info-session-access-token` |

Note the on-record field is snake\_case `client.native_social_login.*`; `nativeSocialLogin` is the camelCase protobuf projection.

## Request handling
\[{"body":"sequenceDiagram\\n    participant App\\n    participant D as GET /e/discovery\<br/\>(@a0-srv/embedded-auth)\\n    participant CS as ClientService\\n    participant Conn as db.connections\\n    participant Tok as POST /oauth/token\\n\\n    App-\>\>D: GET /e/discovery?client\_id=...&connection=...\\n    Note over D: multitenant → embedded\_discovery flag gate (404) → allowOrigins → limitByTenant.oauthApi()\\n    D-\>\>D: validate query parameters (OpenAPI/AJV)\\n    D-\>\>CS: findByTenantAndClientIdAsync(tenant, client\_id)\\n    CS--\>\>D: client (grantTypes, native\_social\_login, embedded\_authorize, embedded\_discovery setting)\\n    D-\>\>D: client resolved? else 401 invalid\_client\\n    D-\>\>D: per-client embedded\_discovery setting enabled? else 400 invalid\_request\\n    D-\>\>Conn: client-enabled connections\<br/\>(filtered by \`connection\` if given)\\n    Conn--\>\>D: \[{ name, strategy, options.authentication\_methods }\]\\n    D-\>\>D: per grant type, apply inclusion rules → alternatives\[\]\<br/\>(capped at MAX\_ALTERNATIVES, in emission order)\\n    D--\>\>App: 200 { alternatives: \[...\] } + Cache-Control: public\<br/\>+ Access-Control-Allow-Origin (allowlisted origins only) + Vary: Origin, Accept-Encoding\\n    App-\>\>Tok: chosen grant (after its own challenge step, where required)","date":1787145676672}\]

## Design decisions

### 1. Register as a sibling route in `EmbeddedAuthRegistration`, reusing the middleware chain but for its own flag gate and caching.

`publicRouteDefinitions` (`packages/embedded-auth/EmbeddedAuthRegistration.js:9`) is already an array of `{ createHandler, path, method }`, and `registerRoutes` loops it applying `multitenant → flagGate → noCache → limitByTenant.oauthApi() → handler`. Discovery takes that chain with **three deliberate divergences**. First, **its flag gate reads** `embedded_discovery`**, not** `andromeda` — the two endpoints are independently enablable (decision #4). (`andromeda` is nonetheless read *inside* the handler, as an inclusion condition for the `authorization_code` alternative — see Inclusion rules and decision #8. It gates one element of the payload, never the route.) Second, **it does not get** `noCache`, because its response is meant to be cached (decision #2). Third, **it gets CORS** — an injected `allowOrigins()` between the flag gate and the rate limiter, plus a companion `OPTIONS` registration for the preflight (decision #11). All three point the same way: the loop's fixed chain becomes per-route, driven by data on the route entry. Adding discovery is one array entry plus a handler at `lib/api/handlers/discovery.js`:

```js
const publicRouteDefinitions = [
  { createHandler: authorize, path: '/e/authorize', method: 'post', flag: 'andromeda' },
  {
    createHandler: discovery,
    path: '/e/discovery',
    method: 'get',
    flag: 'embedded_discovery',
    cacheable: true,
    cors: true,
  },
];
```

`cors: true` does two things in the loop: it splices `allowOrigins()` into the route's own chain, and it registers a second, preflight-only chain through `app.options(route.path, ...)`. Both come off the same route entry, so the `OPTIONS` route cannot drift from the `GET` it answers for.

`#buildFlagGate` takes the flag name as a parameter instead of hardcoding `'andromeda'` (`EmbeddedAuthRegistration.js:74-82`), and the loop builds each route's gate from its own entry. Everything else about the gate — running after `multitenant`, reading the tenant from `req.a0tenant?.record?._id`, `404` on a miss — is unchanged and shared.

`registerRoutes` dispatches through `app[route.method](...)`, so a `GET` entry needs no change to the registration mechanism. It would be the first `GET` in `packages/embedded-auth`, but not in the codebase — `packages/connect-flow/ConnectFlowRegistration.js:46,51` already registers `GET` routes through the same table shape.

The handler follows the package convention: a factory over injected deps returning an Express handler that yields a `HandlerOutcome` (`{ isValid, status?, payload?, error? }`) and builds failures with `oauthError()` rather than throwing — the repo's result-object rule for predictable control flow.

Dependencies come from a **new** `embeddedDiscoveryDeps` **bag** in `packages/server/lib/modules/registry.js`, not from `embeddedAuthDeps`. Discovery is a read-only route and needs roughly a third of that bag: `checkAccessSync` (the same injected flag reader — used for discovery's own flag in the route gate, and in the handler for the inclusion flags of decision #8: the two OTP flags and `andromeda`), `buildSchemaValidationService`, `middlewareUtils`, `middlewares` (`multitenant`, `limitByTenant`, and the two CORS middlewares of decision #11 — an already-constructed `allowOrigins()` and `allowAllOrigins` for the preflight — but **not** `noCache`), `agent`, `getAuthMethodsForLogin`, `getConnectionByNameCached`, plus three additions — a client-loading service, the client+strategy connection query, and `setCacheHeaders`. Everything else in `embeddedAuthDeps` — the orchestrator, `authenticateClientAsync`, `authSessionTokenService`, `cryptoClient`, the TDE pipeline, `parseReqContext`, `usersClient`, the embedded-authorize responder and reporters — has no bearing on a route that authenticates nobody and mutates nothing. A separate bag keeps that unused surface out of discovery's injection seam and out of its tests. Both bags are passed to the same `EmbeddedAuthRegistration`, so discovery still inherits the `withChildLogger('embedded-auth')` agent the constructor applies.

**Rationale:** the route table is designed for exactly this. No new registration mechanism, and rate limiting and tenant resolution come for free. The second flag gate is not a second mechanism — it is the same parameterized helper called with a different flag name, which is what makes the two endpoints independently enablable. A dedicated dependency bag keeps that reuse from dragging in the whole interactive-flow surface.

### 2. `GET` with query parameters, and a response that is cacheable.

Discovery is a pure read with no secret and no structured input: two scalar parameters, `client_id` and an optional `connection`. That fits a query string, `GET` is the correct verb for it, and it generates the idiomatic SDK method — a plain accessor rather than a request-object builder. There is no URL-length concern at two short parameters, and no JSON body worth defining.

The response is **cacheable, and deliberately so**. Discovery is a pure function of tenant, client, and connection configuration — the same URL yields the same answer for every caller until an admin changes something — which is the textbook case for a cached read. It is also called at app start, on the critical path before a user can do anything, so serving it from an edge cache is worth more here than on most endpoints.

`noCache` is therefore dropped from discovery's chain and replaced by the existing `setCacheHeaders` helper (`packages/server/lib/handlers/set_cache_headers.js`), called as `setCacheHeaders(res, 'embedded-discovery')`. That inherits the `METADATA_ENDPOINTS_CACHE_*` defaults already used by `.well-known/openid-configuration` and `.well-known/jwks.json` — `public, max-age=15, stale-while-revalidate=15, stale-if-error=86400` — plus `Vary: Accept-Encoding` and, where `CACHE_TAG_HEADER` is configured, a `Cache-Tag` for CDN purge. No new configuration: discovery reuses the metadata knobs rather than adding its own, and if a longer TTL is wanted later, the precedent for per-endpoint overrides already exists (`MOBILE_ASSOCIATION_ENDPOINTS_CACHE_*`, `WEBFINGER_CACHE_*`).

Two consequences this RFD accepts explicitly. First, **a config change takes up to the TTL to propagate.** At up to 30 seconds in the happy path, that is a fair trade, and `stale-if-error` means an origin failure serves a last-known-good answer instead of blocking app start — a strictly better failure mode than `no-store`. Second, **only success responses carry cache headers.** Dropping `noCache` from the chain means errors would otherwise leave *no* `Cache-Control` at all and become eligible for heuristic caching, so the `400`/`401` paths must set their own no-store headers rather than inheriting silence. `webfinger.js` sets different durations per status class and is the precedent.

Because the tenant is resolved from the hostname by `multitenant`, the cache key is already tenant-scoped: distinct tenants are distinct hosts, hence distinct URLs. `client_id` and `connection` are query parameters and part of the key too. `Origin` is the one addition, because `Access-Control-Allow-Origin` is request-dependent (decision #11), giving `Vary: Origin, Accept-Encoding` — `allowOrigins()` sets the first and `setCacheHeaders` appends the second, and neither clobbers the other. The fragmentation that buys is bounded by configuration rather than by traffic: every caller that sends no `Origin` header at all — which is every native app, the dominant share — shares a single cache entry, and browser traffic fragments only across the handful of origins a client has actually allowlisted.

**Rationale:** nothing about the request needs a body, and the semantics are exactly those of a `GET` — including cacheability, which a `POST` would have forfeited.

### 3. No client authentication: `client_id` and an optional `connection`, nothing more.

The endpoint reads no `client_secret`, no client assertion, and no client certificate. Confidential and public clients are treated identically, and there is no `WWW-Authenticate` challenge. The `client_id` is resolved with a tenant-scoped lookup, `ClientService.findByTenantAndClientIdAsync` per repo policy, never the `insecureDeprecated*` bridge.

A `client_id` that does not resolve for the request tenant is a `401 invalid_client` — the same code and status `/e/authorize` returns for both an unknown client and a tenant mismatch (`packages/embedded-auth/lib/api/handlers/authorize.js:273,283`), so the two endpoints stay consistent. Because the lookup is tenant-scoped, "no such client" and "that client belongs to another tenant" collapse into one indistinguishable outcome; that is the correct disclosure boundary and needs no separate rule.

Accepting a bare `client_id` is not new: `/co/authenticate` (`packages/server/lib/handlers/co/authenticate.js`) takes an unauthenticated `client_id` and gates on per-client settings, which is structurally what discovery does.

**Rationale:** the response is a fact about configuration, not about the caller. Requiring a secret would defeat the endpoint's reason to exist — the public native and SPA clients that need to discover configuration *before* they start have no secret to present, and a client shipping one in a binary would be no more trustworthy than the `client_id` beside it. Access control belongs on the configuration being disclosed (decision #4), not on a credential the caller cannot keep.

### 4. Two-level gating: a new `embedded_discovery` feature flag, plus a per-client `embedded_discovery` setting.

Discovery reveals tenant shape (connection names, which grants and authentication methods are enabled, and whether embedded authorize is enabled for the application) to any caller holding a `client_id` — a value shipped inside the app for public clients. Since the endpoint authenticates nobody (decision #3), the gating is the whole of its access control:

1. **Feature flag** `embedded_discovery` — a **new** belgrano flag, declared in `packages/server/lib/config/schemas/belgrano.js` and evaluated per tenant, returning `404` when the tenant has not been enabled for discovery. It runs through the same `#buildFlagGate` middleware as `/e/authorize`, but on **its own flag — not** `andromeda` (decision #1). Default off, and its removal criterion is Embedded Discovery GA, independent of `andromeda`'s Embedded Auth GA.
2. **Per-client** `embedded_discovery` **setting** — a new per-client toggle, **exposed in the Management API and the Dashboard**, so a tenant admin can enable discovery tenant-wide while choosing which applications may discover configuration. Checked in the handler, since it requires the resolved client.

**Discovery is enablable on its own.** A tenant can be given the `embedded_discovery` feature flag without being in the embedded-auth preview, and enabling `andromeda` does not enable discovery. This is deliberate and load-bearing: the customers who benefit most immediately are the ones already calling ROPG and passwordless directly, who want a pre-flight read in front of grants they use today. For them, turning discovery on is a flag flip — no pipeline migration, no adoption of `POST /e/authorize`, and no change to any existing grant's behaviour.

The corollary holds now that discovery advertises embedded authorize: **without** `andromeda`**, discovery still works** — it simply omits the `authorization_code` alternative and returns everything else the client qualifies for. Advertising the interactive flow did not make the interactive flow's preview switch a prerequisite for reading configuration.

The flag and the setting share the name by design: they gate the same feature at two levels — tenant and application. Because the name is reused, this document and any code comments always say which level is meant: *the* `embedded_discovery` *feature flag* or *the per-client* `embedded_discovery` *setting*. (Compare the unrelated `auth_session` collision noted under Discovery — that one is accidental; this one is not.)

Two further names sit close enough to confuse and are **not** part of that pair. The per-client `embedded_authorize` **property** governs the interactive endpoint, is read here only as an inclusion condition, and is defined outside this RFD. The `type: embedded_authorize` **enum value** is a string in the payload naming which interactive flow an `authorization_code` alternative refers to. Neither is a gate on discovery, and neither is the per-client `embedded_discovery` setting. As with `embedded_discovery`, this document and any code comments always say which of the three is meant.

The two gates differ deliberately in their failure mode. The flag gate is a middleware `404`: it precedes any client resolution, so the endpoint simply does not exist for that tenant and nothing is disclosed. The client-setting check is `400 invalid_request` with a description naming the setting — actionable for the developer, and no masking. `client_id` is a public value, and once a tenant has enabled discovery there is nothing to conceal from a caller that names one of its clients, public or confidential.

It is `invalid_request` rather than an authorization code because nothing was authenticated and no authorization was denied: the request is simply not valid against this tenant's configuration. `unauthorized_client` would imply an authorization decision about a client identity this endpoint never establishes.

The per-client setting is named `embedded_discovery`, snake\_case, following the `native_social_login` precedent for client-record fields (`nativeSocialLogin` is only the camelCase protobuf projection). The name is settled here because it lands in a public Management API surface and the Dashboard, where renaming later is a breaking change.

It defaults to **off** (explicit opt-in): it governs a configuration-disclosure surface, and the safe default for a new disclosure surface is closed. Its scope is settled too — it **gates discovery only.** It is read by this endpoint and no other, and it is not a broader per-client embedded-auth switch; any other embedded-auth capability that needs a per-client control gets its own, specified wherever that capability is designed. That keeps the name honest against what it does, which matters because the name lands in a public Management API surface where renaming later is a breaking change. The same boundary holds one level up: the feature flag gates this endpoint and nothing else.

**Rationale:** the flag alone is too coarse — it is a preview switch that disappears at GA and cannot express "this app may discover, that one may not." The client setting is the durable control and outlives the flag; the flag bounds Beta exposure in the meantime.

The flag is discovery's own rather than `andromeda` because the two features are independent. `andromeda` is the preview switch for an interactive-flow programme with its own timeline; discovery is a read-only view of configuration that already exists, calls nothing that programme owns, and changes no grant's behaviour. Sharing one flag would make an endpoint that works against today's grants contingent on adopting tomorrow's pipeline — and would leave no way to enable either one without the other. Two flags cost one array entry and buy independent rollout, independent Beta cohorts, and independent GA dates.

### 5. Malformed input is a `400`; an empty result is a `200`.

Malformed input — a missing `client_id`, or a `connection` that is not a string — is a `400 invalid_request` from the OpenAPI/AJV layer, mapped to an endpoint error rather than returned raw.

That is the same code the setting-disabled case in decision #4 returns, which is intentional: both mean "this request is not valid against this tenant's configuration", and the `error_description` distinguishes them. That vocabulary is **discovery's own** — a closed snake\_case enum defined by discovery, not the `/e/authorize` enum, which discovery reuses nothing from (decision #6). Callers switch on the description, not on a second status code invented to separate two variants of the same condition.

An empty result is **not** an error. `200 { "alternatives": [] }` is the truthful answer for a client with no matching grants and for a `connection` filter that excludes everything.

**Rationale:** "nothing is available for this client" is a fact about configuration, and the endpoint exists to report facts about configuration. Making it an error would force every SDK to treat a legitimately-unconfigured client as a failure.

### 6. One schema per grant type, selected by a `const` `grant_type`, with intra-grant variation carried in field *values*.

`alternatives` items are a `oneOf` over six variant schemas, each pinning `grant_type` to a `const`:

| `grant_type` | Schema fields beyond `grant_type` |
| --- | --- |
| `authorization_code` | `type` (`embedded_authorize`), `connection` |
| `urn:ietf:params:oauth:grant-type:token-exchange` | `subject_token_type` |
| `password` | — |
| `urn:okta:params:oauth:grant-type:webauthn` | `connection` |
| `http://auth0.com/oauth/grant-type/passwordless/otp` | `type` (`legacy`\|`auth0`), `connection`, `identifier_types[]` |
| `http://auth0.com/oauth/grant-type/password-realm` | `realm` |

The two passwordless scenarios are **one** schema, not two: `type`, `connection`, and `identifier_types` are all present and valid in both — only their values change. Likewise every token-exchange alternative is one schema in which `subject_token_type` is an enum *value*, not a structural switch. So `grant_type` maps 1:1 onto a variant, which is what generates clean SDK models.

**The union carries no OpenAPI** `discriminator` **keyword**, deliberately. Each variant pins `grant_type` with a `const` instead, which already selects exactly one branch of the `oneOf`. The keyword was tried and dropped for a concrete reason: it requires an AJV instance constructed with `discriminator` enabled, and the shared `@a0/oas-ajv-validators` instance is a process-global singleton whose options are fixed at construction. Opting it in meant winning a race to initialise it first, and it broke a real case — `embedded_auth` sorts ahead of `embedded_discovery` and creates the instance lazily *without* the keyword, so the discovery suite then failed with *"Ajv instance already exists"*. A `const` buys the same 1:1 mapping with no cross-schema coupling. The one cost is error text: a rejection reports across all six variants rather than naming the single `grant_type` selected.

`type` on the `authorization_code` variant is a **single-value enum by design**, not a redundant field. It is the seam that lets a second interactive variant land as an enum addition rather than a schema change — the shape `subject_token_type` already has for native social. Note that `type` is **variant-scoped**: it appears on two variants with unrelated meanings and disjoint enums — `legacy`|`auth0` on the OTP variant, `embedded_authorize` here — so an SDK reads it only *after* selecting on `grant_type`, and a generated model must not merge the two into one field.

This has a useful consequence: **adding a native social provider is an enum addition, not a new variant.** A fourth provider extends the `subject_token_type` enum and adds an inclusion rule; the schema union is untouched, and existing generated clients keep deserializing. The same holds for a future third passwordless `type`, and for the `authorization_code` variant's `type`: **federated connections are expected to arrive as an additional** `type` **value** on the alternative defined here — an enum addition, exactly like extending `subject_token_type` for a new provider — not as a new grant type and not as a second array. No tasks are created for that here.

That is also the general answer to how flows are advertised: **inside** `alternatives`**, keyed by** `grant_type`**, with** `type` **distinguishing the variant.** No second top-level array, and no second endpoint. This RFD says nothing about redirect-based `/authorize` in either direction — neither promising it a place in this envelope nor ruling one out.

Request and response schemas live under **discovery's own** `packages/server/lib/schemas/embedded-discovery/` subtree, registered from `packages/server/openapi.json`, and are validated through `SchemaValidationService`, request and response both, as required for all new endpoints. A feature owning its own schema subtree beside the shared `components/`/`paths/` trees is established practice — `lib/schemas/webfinger/` is the precedent. With no request body, discovery contributes no `requestBodies/` entry: the request is declared as OpenAPI **query parameters** on its `paths/` entry, which `SchemaValidationService.validateRequest` already validates through its `queryValidator` branch alongside `paramsValidator` and `requestBodyValidator` (`packages/server/lib/schemas/SchemaValidationService.js:61-72`). A required `in: query` `client_id` on a `GET` has precedent in `packages/server/lib/schemas/paths/IsAllowedOrigin.json`. The `GET` switch therefore costs no validation coverage.

**Discovery shares no schemas with** `/e/authorize`. It defines its own components and `$ref`s nothing under `embedded-authorize/` — including its `error_description` enum, which is discovery's own closed snake\_case enum rather than the one `/e/authorize` uses. (That endpoint's only closed `error_description` enum is access-denied specific — `consent_required`, `too_many_wrong_otp_attempts` — and discovery has no use for either value, but the rule holds independently of today's contents.) The rationale is the same one that gives discovery its own feature flag (#4) and its own `embeddedDiscoveryDeps` bag (#1): two endpoints with independent lifecycles, and a shared error vocabulary would couple two specs that ship and version apart. The concrete tokens are left to the spec (EMBL-1298).

**Rationale:** keeping variation in values rather than schemas is what makes the union stable under growth — and clients switch on `grant_type` alone, reading `type`/`subject_token_type` as data.

### 7. Extra properties appear only where the client functionally needs them.

`authorization_code` carries `type` and `connection`, because the SDK needs the connection name to make the `POST /e/authorize` call and `type` to know that is the endpoint to call. `password-realm` carries `realm`; `otp` and `passkey` carry `connection`; native social carries `subject_token_type`; plain `password` carries nothing, because the server derives the connection from `tenant.default_directory` and the client never sends it.

**Rationale:** the payload states what the client must put into the calls the alternative requires — its `/oauth/token` redemption, plus any challenge or interactive step that has to precede it — and nothing more. It also avoids publishing the default-directory name to clients that have no use for it. The cost — a non-uniform shape across grant types — is exactly what the `grant_type`-keyed union in decision #6 expresses.

### 8. Advertise only what would actually succeed: resolve connections through the same client-scoped lookup the grants use.

The ROPG `password` exchange sets `body.connection = tenant.default_directory` and then resolves it with a **client-scoped** lookup (`getByNameAndClient`, `packages/server/lib/db/connections.js:207`); a default directory not enabled for the calling client fails there. Discovery must resolve through the same client-scoped path, so `default_directory` set but not enabled for this client yields **no** `password` alternative.

Connection enumeration uses the existing client+strategy query (`findActiveByTenantAndClientIdAndStrategies`, `packages/server/lib/db/connections.js:296`) — `auth0`, `ad`, `adfs` and `waad` for the two password grants; `auth0` for passkey, `type: auth0` OTP and embedded authorize; plus `email`/`sms` for legacy OTP — rather than a new query. Embedded authorize adds **no strategy** to that list: `auth0` is already enumerated for passkey and OTP, so the connection query is unchanged. When `connection` is supplied, the single-connection path reuses `getConnectionByNameCached`, already injected into the package.

The per-strategy conditions the password grants add on top of that query — the waad `identity_api` test and the `auth0`-only `getAuthMethodsForLogin` check (see Inclusion rules) — are applied in memory on the projected connection, so the projection must carry `options.identity_api` alongside the authentication-method fields (EMBL-1318).

The same standard applies to **feature flags a grant's own path checks**, not just to connection resolution: where an exchange or its challenge is gated by a tenant flag, that flag is an inclusion condition. There are **two cases in this cut**. `type: auth0` passwordless OTP requires both `allow_otp_database_connection_auth_api` and `allow_otp_database_connection_config`. The `authorization_code` alternative requires `andromeda` — the flag that gates `POST /e/authorize` itself — so a tenant outside the embedded-auth preview is never told to call an endpoint that returns `404` for it (see Inclusion rules). Each future grant type must be checked for the same thing when its rules are written; a grant whose path reads a flag that discovery does not read is a grant discovery can advertise into a guaranteed failure.

**Rationale:** an endpoint whose entire purpose is "tell me what will work" must not advertise a grant that then fails. Sharing the resolution path — and the same flag checks — is the only way to keep the two honest as configuration semantics evolve.

### 9. `alternatives` ordering is deterministic.

Emit in a fixed order — a fixed grant-type order, then connection name ascending within a grant type. Not alphabetical by `grant_type`, and not database order. The grant-type order is:

1. `authorization_code` (embedded authorize)
2. `urn:ietf:params:oauth:grant-type:token-exchange` (native social)
3. `password`
4. `urn:okta:params:oauth:grant-type:webauthn` (passkey)
5. `http://auth0.com/oauth/grant-type/passwordless/otp`
6. `http://auth0.com/oauth/grant-type/password-realm`

The grant-types table above, the example payload, and decision #6's schema table all follow this order, but this decision is where it is defined — a future grant type takes its position here.

**Rationale:** clients cache and diff this payload, and tests assert on it. Stable output makes both cheap; incidentally, a stable order is also a reasonable default render order for a login screen. The *specific* order follows three tiers in sequence: **the preferred path first, then bounded contributors, then per-connection contributors.**

`authorization_code` **leads because embedded authorize is the preferred path.** When a tenant has it, it is the flow Auth0 wants an SDK to take, so it is the first thing a client reads and the first thing a default render order shows. This **deliberately overrides** the fewest-contributions-first rule that orders everything below it: `authorization_code` emits one element per `auth0` connection and is, by that measure, a per-connection contributor that would otherwise sort late. The cost of putting it first is named and accepted in decision #10.

Below it, the remaining grant types are sorted by **how many elements each can contribute**, fewest first, so that the cap in decision #10 truncates deliberately rather than arbitrarily. `password` and native social emit a bounded number regardless of connection count — at most one `password` element ever — so they sort early. `password-realm` emits one element per password-capable connection and is the largest of the per-connection contributors, so it sorts last and absorbs truncation first.

The placement of `password` is deliberate rather than incidental. Ordering it after the passkey, OTP, or `password-realm` grant types would let a tenant with enough eligible connections lose the `password` alternative entirely, and keeping it ahead of them costs the payload nothing. It is no longer an *absolute* guarantee — `authorization_code` sits above it and can consume the whole budget on its own — but among everything below that, `password` is still protected. A new grant type takes its position in this list by the same three-tier test: preferred-path status first, then bounded contributors, then per-connection ones.

### 10. `alternatives` is capped at 100, applied while querying and assembling — never at serialization.

A single module-level constant, `MAX_ALTERNATIVES = 100`, bounds the response, and it does two jobs at once:

- **The connection query takes it as an explicit** `limit`**.** `findActiveByTenantAndClientIdAndStrategies` defaults `limit` to 50 when called without one (`packages/server/lib/db/connections.js:304-307`), so passing the constant is also what stops that default applying by accident (EMBL-1318). One hundred is the right fetch bound because a qualifying connection contributes *at least* one alternative — so 100 connections can always fill a 100-alternative budget, and the query can never under-fetch relative to the cap.
- **Assembly stops emitting once the cap is reached.** The array is bounded as it is built, not assembled in full and sliced on the way out. The cost of a very large tenant is therefore paid in neither the query nor the assembler.

**The cap is not advertised.** No `has_more`, no `total`, no cursor, and no pagination. A response at the cap is indistinguishable from one that happens to hold exactly 100 alternatives. This is a deliberate limitation of this discovery API, accepted on two grounds: a completeness signal is a schema change to a payload that is about to be published to the SDK teams, and pagination is the wrong shape for a payload meant to be fetched once at start-up and cached behind a shared cache (decision #2).

**Truncation is deterministic**, which is what makes it tolerable. Two independent orderings compose:

- Which connections survive the query bound is fixed by the underlying query's own `ORDER BY created_at, connection_id` (`@a0/connections-lib`, `PgsqlConnectionsLibV2`) — the oldest qualifying connections, a stable set across calls. Discovery neither chooses nor needs to choose that order; it only needs it to be stable, and it is. Decision #9's name-ascending order is applied in memory after the fetch, so the two coexist without extending the query API.
- Which alternatives survive the assembly bound follows decision #9's emission order, so the entries dropped are precisely the ones that decision deliberately places last.

**The consequence is named and accepted:** the cap is on `alternatives`, not on connections, and the emission order is grant-type-major, so truncation can cut mid-grant-type. A grant type may be advertised for some connection names and not others, cut at a name boundary, and a tenant whose passkey- or OTP-eligible connections alone exceed the cap can see its budget consumed before `password-realm` is reached.

**The bounded grant types are no longer protected, and that guarantee is void.** Ordering `authorization_code` first (decision #9) places a per-connection contributor above `password` and native social, so the earlier promise that no configuration can cost a client its password or native-social alternative **no longer holds**. Stated plainly: a client with embedded authorize enabled and **100 or more** `auth0`**-strategy connections receives 100** `authorization_code` **alternatives and nothing else** — no native social, no `password`, no passkey, no OTP, no `password-realm`. This is not a corner the cap hides; it is the arithmetic of a 100-element budget filled by the first grant type emitted, and it is accepted as the cost of leading with the preferred path. Every one of these outcomes is stable across calls, which is the property that matters for a payload clients cache and diff.

**Rationale:** an unbounded payload on a start-up critical path is the real risk here, not an incomplete one. Bounding it keeps the response cacheable and its worst case computable, and reaching the cap remains unusual — though **less unusual than it was**. A single `auth0` connection can now contribute up to **four** alternatives (`authorization_code`, passkey, `type: auth0` OTP, and `password-realm`), so roughly 25 fully-featured database connections are enough to fill the budget rather than 100. A client in that position is still offering an implausible number of distinct ways to sign in, and discovery should not be designed around it — but the margin is thinner than one alternative per connection would suggest. Applying the bound in the query and the assembler rather than at the edge of the response is what makes it a real bound on work done rather than a cosmetic one on bytes written.

### 11. Browser access through the existing `allowOrigins()` middleware, with a wildcard preflight.

The RFD's audience is a native **or SPA** application, and a SPA cannot use an endpoint that sends no CORS headers: the request succeeds, and the browser throws the response away. Discovery therefore applies `packages/server/lib/middlewares/cors/allow_origins.js` — the same `allowOrigins()` factory `POST /oauth/token` uses (`lib/auth/protocols/oauth2/handlers/token/token_cors.js`) — with **no factory options**. Its default client-id extractor already reads `req.query.client_id`, and discovery takes no `organization` parameter, so nothing needs configuring.

**The allowlist is the client's, not the tenant's.** After a built-in env-level list (Administration Console, docs, `ALLOWED_ORIGINS`), the origin is checked against the named client's own `allowed_origins` plus its `callbacks`, computed by `isOriginAllowed` through `clientLoadingService.computeAllowedOriginsListAsync`. That is the same list the token endpoint enforces, so **a SPA that can already call** `POST /oauth/token` **cross-origin gets discovery for free** — no second field to configure, and no way for the two to disagree about which origins a client trusts.

The mechanism is **allowlist-gated reflection**: on a match, the `Origin` is echoed back in `Access-Control-Allow-Origin`, along with `Access-Control-Expose-Headers`. On a miss, **the request is not blocked** — this factory has no `deny` option (only `allowWebOrigins` does). The handler still runs and still answers `200`, but without `Access-Control-Allow-Origin`, so the browser discards it and an `fco` tenant log event records the rejected origin. Nothing is disclosed to a disallowed origin that it could read, and nothing extra is disclosed to one that was never allowlisted, because the payload was already reachable by any non-browser caller (decision #3).

`Access-Control-Allow-Credentials` is never set, so the response is **non-credentialed**: no cookie or `Authorization` header rides on it, which is also what keeps the `public` cache entry of decision #2 safe.

**Placement: after the flag gate, before the rate limiter.** After the gate, so a tenant that has not been enabled for discovery gets the bare `404` of decision #4 with no CORS headers to confirm anything. Before `limitByTenant.oauthApi()`, so a rate-limited `429` still carries `Access-Control-Allow-Origin` and the SDK can read the status and the `X-RateLimit-*` values instead of seeing an opaque network error — those header names are already in the `Access-Control-Expose-Headers` list the middleware sets.

**A preflight is reachable, so **`OPTIONS /e/discovery`** is registered.** Auth0 SDKs send `Auth0-Client`, and any custom request header makes an otherwise-simple `GET` non-simple. The preflight chain is `multitenant → flagGate('embedded_discovery') → allowAllOrigins.preflight('get')`, following the pattern `lib/auth/impersonate.js` already uses — a wildcard preflight paired with `allowOrigins()` on the real method. It answers `204` with `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Max-Age: 1000`, and the shared `Access-Control-Allow-Headers` list from `lib/middlewares/cors/default_headers.js`, which already contains `Auth0-Client`.

Two consequences are accepted deliberately. The preflight answers `Access-Control-Allow-Origin: *` regardless of the allowlist, because the allowlist is enforced on the `GET` response — which is the one the browser actually gates reading on, so a permissive preflight grants nothing. And the preflight is not rate-limited: it terminates at `204` before the limiter would run, and does no work beyond tenant resolution and a synchronous flag check.

**Rationale:** this is reuse of an existing, exercised middleware rather than a new CORS path, and it gives discovery and the token call that follows it **one allowlist instead of two**. The alternative — a bespoke allowlist, or static/permissive CORS on the response — would either duplicate configuration a customer has already done or hand any origin a readable copy of the payload, which is the one thing the per-client setting of decision #4 exists to control.

## Discovery: challenge parameters for legacy vs new OTP

The RFD task was to establish what is required to challenge a specific database, and to add whatever property the response needs. **Finding: the two OTP scenarios are asymmetric in both the challenge call and the token call, so** `type` **alone is insufficient to locate the connection —** `connection` **(the connection *****name*****) is required on the alternative, and it is the property added.** Both scenarios address the connection by name, so one property serves both.

|  | Legacy (`email` / `sms` strategy) | New (`auth0` strategy + `email_otp`/`phone_otp`) |
| --- | --- | --- |
| Challenge endpoint | `POST /passwordless/start` | `POST /otp/challenge` |
| Route | `packages/authentication-factors/lib/flows/login/routes/passwordless/index.js:232` | `packages/authentication-factors/lib/otp_auth_api/OtpAuthenticationApiRegistration.js:17` |
| Schema | `packages/server/lib/schemas/definitions/start_passwordless.js` | `packages/server/lib/schemas/components/requestBodies/OtpChallenge.json` |
| Required | `connection`, one of `email`/`phone_number` | `client_id`, `connection`, one of `email`/`phone_number` |
| Notable optional | `send` (`code`\|`link`\|`link_android`\|`link_ios`, **default** `link` — OTP needs `send=code`), `authParams`, `captcha` | `delivery_method` (`text`\|`voice`, default `text`; phone only), `allow_signup` (default `false`) |
| `client_id` required? | Conditional, per `require_clientid_on_passwordless_start` | Always |
| Challenge returns | — (code delivered out of band) | `{ auth_session }` — an opaque ticket |
| Feature flag | — (legacy, nothing gates it) | `allow_otp_database_connection_auth_api` (challenge); the exchange requires it **and** `allow_otp_database_connection_config` — both are inclusion conditions, see Inclusion rules |
| `/oauth/token` **params** | `otp` + `realm` (connection name) + `username` | `otp` + `auth_session`; `realm`/`username` are **rejected** |

Both flows share `grant_type: http://auth0.com/oauth/grant-type/passwordless/otp` and are separated inside the exchange by the presence of `auth_session`, which is mutually exclusive with `realm`+`username` (`packages/server/lib/auth/protocols/oauth2/exchange/passwordless-otp.js`, mutual-exclusion check at \~214-218; legacy strategies pinned to `sms`/`email` at \~18). Entering the `auth_session` branch at all requires **both** `allow_otp_database_connection_auth_api` and `allow_otp_database_connection_config` (`:209-213`); with either off, the exchange falls through to the legacy realm branch and rejects the call with `Missing required parameter: realm`. Hence both flags are inclusion conditions for `type: auth0`, not just documentation — see Inclusion rules.

Consequence for the schema: `type` is the switch an SDK uses to choose endpoint **and** token-parameter shape, and `connection` is what it passes to the challenge. Per decision #6 both are values on one schema; the response stops there and does **not** publish endpoint paths or parameter lists, so SDKs carry that mapping.

**Delivery options are deliberately not surfaced.** The optional parameters that differ between the two challenge calls — `delivery_method` (`text`|`voice`) on `/otp/challenge`, and `send=code` on `/passwordless/start` — stay out of the payload. Both are *inputs the caller chooses*, not configuration it must discover: `send=code` is a constant for any OTP client (the `link` default is the magic-link flow, a different product), and `delivery_method` defaults to `text` with `voice` available to any phone-capable connection, so there is no per-connection fact to report. Adding them would put SDK call arguments in a discovery response and grow the schema without telling the client anything it could not have hardcoded. The `type` + `connection` pair is sufficient for an SDK to construct either challenge correctly.

 **Naming collision:** `/otp/challenge` returns a field named `auth_session`, and embedded auth uses `auth_session` for its sealed, rotating envelope (`packages/embedded-auth/lib/session/`). These are unrelated values with the same name. The RFD does not rename either, but SDK docs and any shared types must keep them distinct.

## Cross-cutting concerns

- **Security.** The endpoint is an **unauthenticated configuration-disclosure surface**: it returns connection names, enabled grants, enabled authentication methods, and whether the application is enabled for embedded authorize to any caller that names a `client_id`. Since there is no client authentication to lean on (decision #3), the remaining mitigations carry the whole weight: the `embedded_discovery` feature flag, the per-client `embedded_discovery` setting — which is what lets an admin enable discovery tenant-wide without exposing configuration through every application — tenant rate limiting, and returning only what is enabled *for the named client*, never a tenant-wide inventory. Discovery is read-only: no state is created and no identifier of any kind is accepted, so it adds **no user-enumeration surface** (it never takes an email or phone number, unlike the challenge endpoints it precedes) and nothing to brute force. Responses must never include connection `options` beyond the derived booleans, client secrets, or IdP credentials. The residual is explicit and accepted: anyone holding a `client_id` extracted from a shipped app can read that client's enabled grants and connection names, and whether it is embedded-authorize enabled — which, because that alternative also requires `andromeda`, indirectly reveals the tenant's preview state for that feature. This is precisely why the setting is opt-in and per-client, and why the flag gating it is discovery's own rather than one shared with an unrelated feature. Responses are `public`-cacheable at shared caches (decision #2), which follows from the same reasoning: the payload is not caller-specific and carries no credential, so there is nothing in it that a shared cache must not hold. Browser access does not weaken that: it is gated by the same per-client origin allowlist `POST /oauth/token` enforces, and the response is non-credentialed — `Access-Control-Allow-Credentials` is never set (decision #11) — so no cookie or bearer credential is ever attached to a cacheable response, and the one origin-specific header, `Access-Control-Allow-Origin`, is kept out of the wrong cache entry by `Vary: Origin` rather than by trust in the cache. The per-client `embedded_discovery` setting is what bounds what reaches such a cache in the first place; error responses are never cached.
- **Observability.** Continue the `withChildLogger('embedded-auth')` namespace. Emit one structured event per call with tenant, `client_id`, whether a `connection` filter was supplied, and the returned-alternative count — enough to catch a spike in `alternatives: []` (a misconfiguration signal) and to see how much traffic is filtered vs. unfiltered. Count setting-disabled failures separately from schema rejections: both are `400 invalid_request` (decision #5), so the counter must key on the `error_description` or an internal reason tag rather than on status alone. The signal is worth the extra dimension — a sustained setting-disabled rate means apps are shipping discovery against clients whose `embedded_discovery` setting was never enabled. Never log identifiers.
- **Reliability.** Reads only: one client lookup plus one connection query, both already on hot paths elsewhere and cached. No writes, no new datastore, no dependency on the MFA or OTP backends. A failure is a plain JSON OAuth2 error; the endpoint being down blocks discovery, not authentication, since the grants remain callable directly. `stale-if-error` softens even that: a cached answer keeps being served through an origin outage (decision #2).
- **Scalability / cost.** One extra request per app start (or per cached TTL), cheaper than the interactive flow it precedes. Cost is bounded by connection count per client; per-request connection lookups should reuse existing caches. The payload grows linearly with qualifying connections — up to about **four** elements per `auth0` connection (`authorization_code`, passkey, `type: auth0` OTP, and `password-realm`), not one — but not without limit: `MAX_ALTERNATIVES` caps it at 100 entries, enforced in the connection query and the assembler, so both the response size and the work behind it have a computable worst case (decision #10).
- **Limits.** Inherits `limitByTenant.oauthApi()`. Because discovery is called before any user input, it is plausibly *more* frequent per install than `/oauth/token` — though cache hits are absorbed at the edge and never reach the limiter, so the rate that matters is post-cache. Whether it needs its own bucket is an open item.

## Non-Goals

- **Organization support** — explicitly deferred. Organization-scoped filtering (which connections are enabled for an org, org-required clients) is a known follow-up.
- **The Management API and Dashboard surface for the per-client** `embedded_discovery` **setting** — this RFD specifies that the setting exists, its name, what it gates, and its failure mode; the API field definition, validation, and Dashboard UI are separate deliverables owned outside this package. (The `embedded_discovery` feature flag is a belgrano flag and is not itself settable through any public API — but it does gate the per-client setting's Management API surface, hiding the field on read and rejecting it on write while the flag is off for a tenant.)
- **The per-client** `embedded_authorize` **property** — this RFD *reads* it as an inclusion condition and specifies nothing about it: not its field definition, validation, Management API surface, or Dashboard UI, all of which are owned outside this RFD. It does not exist on the client record yet, and discovery cannot emit an `authorization_code` alternative until it does.
- **Gating any other endpoint** — the `embedded_discovery` feature flag gates `/e/discovery` and nothing else, and `andromeda` gates `/e/authorize` and nothing else **as an endpoint**. Endpoint-level independence is intact: neither flag implies the other, and neither is a prerequisite for the other. `andromeda` does appear *inside* discovery, as an inclusion condition for the `authorization_code` alternative (decision #8) — but that is discovery reading a fact about the tenant, not discovery gating, or being gated by, another endpoint.
- **Challenge delivery options** — `delivery_method` (`text`/`voice`) and `send=code` are caller-chosen arguments to the challenge endpoints, not discoverable configuration, and are not in the payload (see Discovery).
- **MFA discovery** — `/e/discovery` describes *primary* authentication. A grant listed here may still return `mfa_required`; enrolled factors are not discoverable through it.
- **Signup / enrollment discovery** — no advertising of whether a connection allows signup, its password policy, or its enrollment options. (`allow_signup` exists on `/otp/challenge`, but discovery does not surface it.)
- **Password policy details** — `password` carries no extra fields for now; policy metadata may be added later.
- **Endpoint paths and parameter lists in the payload** — SDKs map `grant_type` + `type` to the call to make (decision #6, Discovery section).
- **Changing any grant's behaviour** — discovery is purely descriptive. No change to ROPG, passwordless, passkey, token-exchange, or embedded authorize semantics — including no change to what `POST /e/authorize` accepts, which of its own accord checks neither `grantTypes` nor connection strategy (see Inclusion rules).
- **Connection-level branding or display metadata** — no display names, logos, or ordering hints beyond the deterministic order in decision #9.
- `client_id`**-less discovery** — there is no tenant-wide variant. Every request names exactly one client, and the response is scoped to it.

## Open Questions

1. **Unknown** `connection` **name.** The status codes and error codes are settled in decisions #3, #4, and #5: `400 invalid_request` for malformed input *and* for the per-client `embedded_discovery` setting not being enabled, `401 invalid_client` for a `client_id` that does not resolve for the tenant. What remains is which of those a *non-existent* connection falls under: does an unknown `connection` name yield `400 invalid_request` or `200 { alternatives: [] }` — a filter naming a connection that does not exist is arguably malformed input, but it is indistinguishable to the caller from a filter that excludes everything.

## Resources

- **Key code anchors (auth0-server):**
    - Registration & route table: `packages/embedded-auth/EmbeddedAuthRegistration.js` (`publicRouteDefinitions`, `#buildFlagGate` at `:74-82`); `GET`-route precedent in `packages/connect-flow/ConnectFlowRegistration.js`; new `embeddedDiscoveryDeps` bag alongside `embeddedAuthDeps` in `packages/server/lib/modules/registry.js`
    - Feature flags: declarations in `packages/server/lib/config/schemas/belgrano.js` (`andromeda` at `:2171`; `embedded_discovery` to be added alongside it; OTP inclusion flags `allow_otp_database_connection_auth_api` at `:2098` and `allow_otp_database_connection_config` at `:2102`); `checkAccessSync` in `packages/server/lib/feature_flags/index.js`; `featureFlagHelper`/`toggleFeatureFlag` in `packages/server/test/support/envHelper.js` for enabling a flag in tests
    - OTP flag check sites: challenge gate in `packages/authentication-factors/lib/otp_auth_api/handlers/featureFlagVerifier.js:13`; exchange branch condition in `packages/server/lib/auth/protocols/oauth2/exchange/passwordless-otp.js:209-213`
    - Cache headers: `packages/server/lib/handlers/set_cache_headers.js`; `METADATA_ENDPOINTS_CACHE_*` defaults in `packages/server/lib/config/schemas/caching.js`; per-status precedent in `packages/server/lib/handlers/webfinger.js`
    - CORS (decision #11): `packages/server/lib/middlewares/cors/allow_origins.js` (the `allowOrigins()` factory), `cors/allow_all_origins.js` (`allowAllOrigins.preflight()`, a thin re-export of `createAllowAllOrigins` from `@a0-srv/server-core`), `cors/default_headers.js` (the shared `Access-Control-Allow-Headers` list, which already contains `Auth0-Client`); precedents in `packages/server/lib/auth/protocols/oauth2/handlers/token/token_cors.js` (`POST /oauth/token`) and `lib/auth/impersonate.js` (wildcard preflight paired with `allowOrigins()`); allowlist computation in `lib/auth/client/is_origin_allowed.js` via `clientLoadingService.computeAllowedOriginsListAsync`
    - Handler conventions: `packages/embedded-auth/lib/api/handlers/authorize.js`, `lib/oauth_error.js`; discovery's own schemas under `packages/server/lib/schemas/embedded-discovery/`, registered from `packages/server/openapi.json` (subtree precedent: `lib/schemas/webfinger/`); query-parameter validation in `packages/server/lib/schemas/SchemaValidationService.js`
    - Embedded authorize (the `authorization_code` path): handler at `packages/embedded-auth/lib/api/handlers/authorize.js`; success shape `packages/server/lib/schemas/embedded-authorize/responses/EmbeddedAuthorizeSuccess.json`, which returns `{ authorization_code }` — the value redeemed at `POST /oauth/token`. The terminal code-issuing step is still stubbed (`501 not_implemented`) at `packages/embedded-auth/lib/orchestrator/handlers/verify_otp.js:110-116`, pending EMBL-1197
    - Client lookup: `packages/server/lib/auth/client/clientLoadingService.js`, `lib/auth/client/client_service.js` (`findByTenantAndClientIdAsync`)
    - Grants & clients: `packages/server/lib/auth/client/client_service.js` (`hasGrantType`), `lib/auth/protocols/oauth2/utils.js` (`validateClientGrants`), `lib/auth/protocols/oauth2.js:151-152` (`PASSWORD_REALM_GRANT`, `PASSWORDLESS_OTP_GRANT`)
    - Connections & auth methods: `packages/server/lib/prompts/model/connections.js:730` (`getAuthMethodsForLogin`), `lib/db/connections.js:207,296`
    - ROPG / default directory: `packages/server/lib/auth/protocols/oauth2/exchange/password.js` (`tenant.default_directory`)
    - Passwordless OTP: `packages/server/lib/auth/protocols/oauth2/exchange/passwordless-otp.js`; `packages/authentication-factors/lib/otp_auth_api/`; `packages/authentication-factors/lib/flows/login/routes/passwordless/index.js`
    - Passkey: `packages/server/lib/auth/protocols/oauth2/passkey/` (`passkeyExchangeConstants.js`, `passkeyExchangeSchema.js`)
    - Native social token exchange: `packages/server/lib/auth/protocols/oauth2/token_exchange/profiles/native-social/{google,apple,facebook}.js`
