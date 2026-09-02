# Redirect to Web Flows in Embedded Authorization

> **Amended 2026-09-02 to the settled contract.** This copy differs from the Confluence original
> where the documents contradicted each other or [draft-ietf-oauth-first-party-apps-04](https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/).
> Each change is marked **AMENDED** inline with its reason. The machine-readable record is
> `DECISIONS` in `src/data/spec.js`; the simulator is held to it by `tests/webflows.test.js`.
>
> | Changed | From | To |
> | --- | --- | --- |
> | Error code on a browser handoff | `redirect_to_web` on Path B only; `insufficient_authorization` on Path A, forms and Actions redirects | `redirect_to_web` + top-level `request_uri` on **every** leg that opens a browser |
> | Initiate request | no PKCE shown | `code_challenge` + `code_challenge_method` REQUIRED to receive a `request_uri` |
> | Native social artifact | `id_token` | `idp_artifact` + `idp_artifact_type` |
> | Post-login form resume | `action:interaction:form:verify:v1` | `action:interaction:form:v1` |
> | Web-leg descriptors | TTL held server-side only | `expires_in` returned to the client |
> | Open Question 1 | open | resolved — resume on the connection-specific action |

> **Vision document — not a final spec or product commitment.**  
> This document explores how redirect-to-web cases could work in embedded flows to guide design thinking and align the team on a common pattern. The flows, naming, and mechanisms described here are directional. Not all features discussed are committed or scheduled. This document also serves as the conceptual foundation for the bot detection / CAPTCHA implementation (see [Bot Detection Challenge for Embedded Authorize](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1040944724/Bot+Detection+Challenge+for+Embedded+Authorize)), which is the near-term delivery this thinking is guiding.

## Overview

The `/e/authorize` endpoint is the path to full parity with Universal Login. Two major UL capabilities are currently unavailable in embedded flows:

- **Federation** — social and enterprise connections that require browser-based OAuth2/SAML/OIDC redirects
- **Post-login web interactions** — Actions that trigger a hosted form or a redirect to a customer-defined URL

A third related case — **Bot Detection / CAPTCHA** — is documented in [Bot Detection Challenge for Embedded Authorize](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1040944724/Bot+Detection+Challenge+for+Embedded+Authorize). All three share the same underlying architecture, described here as the **escape-to-web pattern**.

---

## The Common Architecture

Every redirect-to-web case follows this shape:

```
POST /e/authorize  →  server detects web-only interaction required
  ← 403 { error: "redirect_to_web",
           request_uri: "urn:ietf:params:oauth:request_uri:<opaque>",
           auth_session: "...",
           next: [{ action: "...", href: "...", expires_in: N }] }

App opens browser / WebView with href

User completes web-only interaction (IDP login, CAPTCHA, form, redirect)

Auth0 processes result → advances auth_session server-side

Callback: myapp://<scheme>  ← no tokens, no auth codes

App resumes: POST /e/authorize { auth_session: "...", action: "..." }
  ← pipeline continues natively (MFA, Actions, etc.)
  or 200 { authorization_code: "..." }
```

### Key invariants

`auth_session` is the durable anchor. The `auth_session` spans both the native and web legs. When resuming, the app passes the same `auth_session` — not the state token from the callback. The server derives the web leg result from the session state.

**Callbacks carry no tokens.** The callback URL is a completion signal only. All authentication material — IDP tokens, CAPTCHA clearance, form results, redirect outcomes — is processed and stored server-side. The app only ever receives an Auth0 authorization code from the final successful `/e/authorize` call.

**The coordination reference is a short-lived server-side handle, not a token and not an OAuth** `state`. Each `href` carries a `request_uri` parameter formatted as `urn:ietf:params:oauth:request_uri:<opaque>` — a lookup key that points to the server-side record for this web leg. It carries no authentication material and is not replayable from a different session.

The `request_uri` URN format is borrowed from [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126) (PAR). We use the format only — not the full PAR protocol. It avoids inventing new terminology and has no collision with the OAuth2 `state` parameter.

**A leg resumes on the action it was offered under. (AMENDED)** Whatever action appears in `next[]` is the action the client sends back — CAPTCHA, federation, forms and Actions redirects all follow the one rule. `next[]` is the server-side allow-list (D2 decision #3), and that is what stops a client skipping a step; admitting an action that was never advertised would turn it into a guideline. This retires `action:interaction:form:verify:v1`, the only id that broke the pattern.

**A pause that opens a browser is `redirect_to_web`; a pause the client handles in-app is `insufficient_authorization`. (AMENDED)** One rule, applied consistently — this document previously used `redirect_to_web` on Path B alone and the continuation code everywhere else. The distinction the client acts on is *do I have to leave the app*, so that is what the error code states rather than something to infer from the presence of an `href`. The native Forms SDK path is the boundary case: it pauses the pipeline but renders inline, so it is `insufficient_authorization`. See "Alignment with the IETF draft" below.

**The pipeline continues natively after the web leg.** After resuming, the server returns the next required action — MFA, another form, etc. — or issues the authorization code if the pipeline is complete.

**Descriptors carry `expires_in`. (AMENDED)** Each case has its own TTL and the client is told what it is, in seconds, so an app can distinguish an expired `href` from a broken one and refresh before a user hits a dead page.

---

## Alignment with the IETF draft

`/e/authorize` implements [draft-ietf-oauth-first-party-apps-04](https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/). The draft defines two error codes that matter here, and they are not interchangeable:

> **`insufficient_authorization`** — "The presented authorization is insufficient, and the authorization server is requesting the client to take additional steps to complete the authorization… continue to make requests to the authorization server until the authorization request is fulfilled and an authorization code returned." MUST be HTTP 403.

> **`redirect_to_web`** — "The request is not able to be fulfilled with **any further direct interaction with the user**. Instead, the client should initiate a **new authorization code flow** so that the user interacts with the authorization server in a web browser."

The draft's usage text points squarely at our cases:

> "The authorization server may choose to interact directly with the user **based on a risk assessment**, the **introduction of a new authentication method not supported in the application**, or to handle an exception flow such as account recovery. To indicate this error to the client, the authorization server returns an error response as defined above with the `redirect_to_web` error code."

Risk assessment is bot detection. An authentication method the app cannot perform natively is federation. So `redirect_to_web` is the code for every leg here that opens a browser.

**Where this stretches the draft, honestly.** The definition above says the request "is not able to be fulfilled with **any further direct interaction with the user**", and our legs *do* come back to `/e/authorize` — a CAPTCHA is followed by a password, federation can be followed by native MFA. The draft is **silent on what happens after the browser interaction**: it never says the client cannot return to the challenge endpoint. So this reading stretches a definition rather than breaking a rule, and it is a decision, not a citation. The alternative — treating every leg as `insufficient_authorization` and letting the `href` imply the browser — was considered and rejected, because it leaves the one thing the client must do differently unstated.

**PKCE is now required at initiate. (AMENDED)**

> "If the client does not include a PKCE `code_challenge` in the initial authorization challenge request, the authorization server MUST NOT return a `request_uri` in the `redirect_to_web` error response, as that would effectively be the same as a PAR request without PKCE."

No example in this document previously sent a `code_challenge`, so as written it could not legally return the `request_uri` it shows. The initiate request now carries `code_challenge` + `code_challenge_method`. Without them the handoff still returns `redirect_to_web` and its `href`; only the `request_uri` is withheld, which matches the draft's own fallback — a client with no `request_uri` starts its own authorization code flow with PKCE.

**A known limit of this shape.** The draft's `request_uri` is consumed per RFC 9126 §4: the client navigates to `/authorize?client_id=…&request_uri=…`. Federation's `href` already is that URL, so a draft-only client works. CAPTCHA and forms live at `/captcha` and `/form`, so for those the actionable instruction is the `href` and the top-level `request_uri` is informational. Folding every leg behind `/authorize?request_uri=…`, dispatched server-side on the record's `type`, would close that gap — the Redis record already carries the type. Worth doing if a spec-compliant SDK ever has to work without understanding `next[]`.

**What the draft leaves to us.** There is no `next[]` array, no action identifiers and no capability negotiation in the draft, and it says so: *"These new error codes are specific to the authorization server's implementation of this specification and are intentionally left out of scope."* That vocabulary is ours to define, which is why the amendments above are decisions rather than corrections.

---

## Coordination Reference Model

Each redirect-to-web case stores a server-side record identified by a `request_uri` formatted as `urn:ietf:params:oauth:request_uri:<opaque>`. The shape is the same across cases; TTL and binding controls differ.

The `request_uri` URN format is borrowed from [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126) (PAR). We use the format only — not the full PAR protocol. It avoids inventing new terminology and has no collision with the OAuth2 `state` parameter.

> **Implementation note — PAR is already live in Auth0:** Auth0 ships full PAR support (`/oauth/par`) today. The opaque `request_uri` issuance, server-side reference store, and TTL-bounded lookup are already in production. This design intentionally reuses that existing pattern — the coordination reference follows the same model, so the technical implementation can build on what Auth0 already has rather than creating new plumbing from scratch.

### Bot Detection (CAPTCHA)

```
Redis key: urn:ietf:params:oauth:request_uri:<opaque>

{
  "auth_session_ref": "<hash of auth_session>",
  "status":           "PENDING",
  "ip":               "203.0.113.42",
  "asn":              "AS15169",
  "ttl":              90s
}
```

Binding controls: IP/ASN match validated on CAPTCHA page load; optional nonce cookie for per-device binding (iOS/SPA only). Single-use — consumed when the app resumes, IP/ASN stamped onto the `auth_session`.

### Federation

```
Redis key: urn:ietf:params:oauth:request_uri:<opaque>

{
  "auth_session_ref": "<hash of auth_session>",
  "response_type":    "none" // either return nothing or an error 
  "status":           "PENDING",
  "connection":       "google-oauth2",
  "nonce":            "<oidc_nonce>",    // for OIDC connections only
  "ttl":              300s               // longer — IDP round-trip takes time
}
```

Auth0's `/authorize` looks up the Redis record via the `request_uri` to find the connection and nonce — no `auth_session` is involved at this stage. Once the IDP redirect completes, Auth0 `/callback` marks the record COMPLETE. When the app resumes, Auth0 decodes the `auth_session`, extracts the opaque reference, and validates against the Redis record.

### Post-login Web Interactions (Forms / Redirect with Actions)

```
Redis key: urn:ietf:params:oauth:request_uri:<opaque>

{
  "auth_session_ref": "<hash of auth_session>",
  "status":           "PENDING",
  "type":             "form" | "redirect",
  "client_id":        "<client_id>",     // stored here — not passed as a URL param
  "form_id":          "<form_id>",       // for type=form only
  "redirect_to":      "<url>",           // for type=redirect only
  "ttl":              600s
}
```

`client_id` is resolved from the coordination reference — not passed as a URL parameter.

---

## Use Case Matrix

| Use case | Action in `next[]` | Resume action | Binding |
| --- | --- | --- | --- |
| Bot Detection / CAPTCHA | `action:interaction:captcha:verify:v1` with `href` | `action:interaction:captcha:verify:v1` | IP/ASN + nonce cookie |
| Federation (social / enterprise) | N × `authn:federated:<connection>:v1`, one per eligible connection; Path A (HRD resolved): also includes `href`; Path B (ambiguous): no `href` — client echoes chosen action, server returns `href` in second response | `authn:federated:<connection>:v1` | `request_uri` in OAuth2 `state` / SAML `RelayState`; `auth_session_ref` on resume |
| Native Social | `authn:ns:google:v1` — no `href` | `authn:ns:google:v1` with `idp_artifact` + `idp_artifact_type` | N/A — fully native |
| Post-login form (Actions) | `action:interaction:form:v1` with `href` | `action:interaction:form:v1` **(AMENDED)** | `request_uri` in URL; `auth_session_ref` on resume |
| Post-login redirect (Actions) | `action:interaction:web:v1` with `href` | `action:interaction:web:v1` | `request_uri` in URL; `auth_session_ref` on resume |

---

## Detailed Flows

### Federation

Federation covers any connection that delegates authentication to an external identity provider via a browser redirect:

- **Enterprise connections** — `samlp`, `waad`, `adfs`, `oidc`, `wsfed`, `ad`, `ldap`, `pingfederate`. Always browser-redirect; no native SDK path exists.
- **Social connections** — any provider where `strategy === name` **and** no native SDK is configured for that provider on the client.

**The connection name is encoded in the action string** — `authn:federated:<connection-name>:v1`. The server emits one item per eligible connection. `strategy` alone cannot discriminate — a client can have multiple connections with the same strategy (e.g., two separate `oidc` enterprise connections). The client declares the generic capability `authn:federated:v1`; the server expands it to specific per-connection actions in `next[]`.

#### Path A — HRD auto-resolution

The identifier's email domain maps to a single federated connection via HRD. The server resolves it immediately and returns the `href` — one round-trip.

```
POST /e/authorize
{
  "client_id": "{{client_id}}",
  "scope": "openid profile email",
  "audience": "{{audience}}",
  "identifier": "alice@company.com",
  "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method": "S256",
  "capabilities": [
    "action:identify:email:v1",
    "authn:federated:v1"
  ]
}

// alice@company.com maps to an enterprise SAML connection via HRD.
// Server generates the coordination reference immediately and returns href.
→ 403 {
    "error": "redirect_to_web",
    "request_uri": "urn:ietf:params:oauth:request_uri:fed_8xKpQrT2",
    "auth_session": "eyJ...(contains opaque reference, federation-pending)",
    "next": [{
      "action": "authn:federated:company-saml:v1",
      "href": "https://{{tenant}}.auth0.com/authorize?request_uri=urn:ietf:params:oauth:request_uri:fed_8xKpQrT2",
      "expires_in": 300
    }]
  }
```

#### Path B — Client-selected federation

The identifier doesn't unambiguously resolve to a single connection. This happens in several common cases:

- `alice@gmail.com` could authenticate via password or via Google social login.
- A client has two social connections (e.g., Google and GitHub) — the user can pick either.
- A client supports a social connection and an enterprise connection — both are eligible.
- A client has two enterprise connections with the same strategy (e.g., two separate `oidc` connections for different corporate IDPs).

`strategy` alone is not sufficient to discriminate — multiple connections can share the same strategy value. The server returns one `authn:federated:<connection>:v1` item per eligible federated connection. The client renders the appropriate options and signals which the user chose by echoing the specific action string.

```
POST /e/authorize
{
  "client_id": "{{client_id}}",
  "scope": "openid profile email",
  "identifier": "alice@gmail.com",
  "capabilities": [
    "action:identify:email:v1",
    "action:verify:password:v1",
    "authn:federated:v1"
  ],
  "redirect_uri" : "myapp:deep_link_to_my_app" // optional
}

// Multiple options available. Server returns one item per eligible connection, no href yet.
// The connection name is encoded in the action string — no extra fields needed.
→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...",
    "next": [
      { "action": "action:verify:password:v1" },
      { "action": "authn:federated:google-oauth2:v1" },
      { "action": "authn:federated:github:v1" }
    ]
  }

// Client renders "Continue with Google" and "Continue with GitHub" — user taps one.
// Client echoes the chosen action. No extra fields needed.
POST /e/authorize
{
  "auth_session": "eyJ...",
  "action": "authn:federated:google-oauth2:v1"
}

// Server validates the action is an eligible option for this auth_session.
// Generates coordination reference, returns href.
//
// This shape is now used for EVERY browser handoff, not just Path B. The request_uri is present
// because the initiate call carried a PKCE code_challenge; without one it is withheld.
→ 403 {
    "error": "redirect_to_web",
    "request_uri": "urn:ietf:params:oauth:request_uri:fed_8xKpQrT2",
    "auth_session": "eyJ...(federation-pending)",
    "next": [{
      "action": "authn:federated:google-oauth2:v1",
      "href": "https://{{tenant}}.auth0.com/authorize?request_uri=urn:ietf:params:oauth:request_uri:fed_8xKpQrT2",
      "expires_in": 300
    }]
  }
```

#### After href is returned (both paths)

```
// Step 2: App opens WebView / system browser with href.
//
// Auth0 generates all upstream protocol requirements server-side before redirecting to the IDP.
// The app and SDK are never involved: PKCE, state, nonce, response_type, and IDP-specific params
// are produced by Auth0 — same path Auth0 uses today for Universal Login federation.
//
//   - OIDC/OAuth2: opaque value encoded into OAuth2 `state` sent to IDP
//   - SAML: opaque value encoded into RelayState
//
// Auth0 /callback:
//   - Decodes opaque value → locates Redis record (PENDING → COMPLETE)
//   - Exchanges IDP code / validates assertion
//   - Stores IDP tokens in token vault
//   - Redirects to: myapp://callback  ← deep link; no tokens, no auth code, potential error = response_type:none -> either
//   redirect_uri indicated by the client or the single one configuration in the client (Auth0 configuration)


// Step 3: App resumes. Uses the same connection-specific action from the last next[].
POST /e/authorize
{
  "auth_session": "eyJ...(federation-pending)",
  "action": "authn:federated:google-oauth2:v1"
}

// Continue into the pipelien till completion

// If MFA required:
→ 403 { "next": [{ "action": "action:challenge:oob:v1" }] }

// If post-login form required:
→ 403 { "error": "redirect_to_web", "request_uri": "urn:...",
         "next": [{ "action": "action:interaction:form:v1", "href": "...", "expires_in": 600 }] }

// If pipeline complete:
→ 200 { "authorization_code": "eyJ..." }
```

---

### Native Social

Native social (Google, Apple, Facebook via first-party SDK) does **not** use the redirect-to-web pattern. No WebView, no browser.

```
POST /e/authorize
{
  "client_id": "{{client_id}}",
  "scope": "openid profile email",
  "identifier": "alice@example.com",
  "capabilities": ["action:identify:email:v1", "authn:ns:google:v1"]
}

→ 403 {
    "next": [{ "action": "authn:ns:google:v1" }]   // no href
  }

// App authenticates natively with Google SDK, receives an access token.
//
// AMENDED: this was "id_token": "<google_access_token>" — a field named for an ID token carrying
// an access token, and hedged in prose as "might be id_token or another artifact". The three
// providers do not return the same kind of thing, so no single token-shaped name is honest:
// Apple returns an authorization code. The type therefore travels WITH the artifact rather than
// being inferred from the action id, which would break the moment a provider returns two kinds.

POST /e/authorize
{
  "auth_session": "eyJ...",
  "action": "authn:ns:google:v1",
  "idp_artifact": "<google_access_token>",
  "idp_artifact_type": "urn:ietf:params:oauth:token-type:access_token"
}

// Continue into the pipelien till completion

// If MFA required:
→ 403 { "next": [{ "action": "action:challenge:oob:v1" }] }

// If post-login form required:
→ 403 { "error": "redirect_to_web", "request_uri": "urn:...",
         "next": [{ "action": "action:interaction:form:v1", "href": "...", "expires_in": 600 }] }

// If pipeline complete:
→ 200 { "authorization_code": "eyJ..." }
```

> **Provider artifacts and their `idp_artifact_type`:**
>
> | Provider | Artifact | `idp_artifact_type` |
> | --- | --- | --- |
> | Google | access token | `urn:ietf:params:oauth:token-type:access_token` |
> | Facebook | access token | `urn:ietf:params:oauth:token-type:access_token` |
> | Apple | authorization code | `http://auth0.com/oauth/token-type/apple-authz-code` |
>
> Access tokens use the URN [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) already registers, rather than a parallel Auth0-namespaced one. Apple's authorization code has no registered equivalent, so it keeps the proprietary URN. **The server rejects a mismatch** — claiming Apple's URN for a Google artifact is a `400`, which is the point of making the type explicit rather than inferring it.

---

### Post-login Form (Actions)

> Deep-dive on Forms API integration: see [Forms Integration in Embedded Authorization](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1045602836/Forms+Integration+in+Embedded+Authorization) (sibling page).

```
// Authentication completed natively. Post-login Actions pipeline requires a form.

POST /e/authorize
{
  "auth_session": "eyJ...(post-authn)",
  "action": "action:verify:password:v1",
  "password": "<USER_PASSWORD>"
}

→ 403 {
    "error": "redirect_to_web",
    "request_uri": "urn:ietf:params:oauth:request_uri:form_9tBrKx",
    "auth_session": "eyJ...(form-pending)",
    "next": [{
      "action": "action:interaction:form:v1",
      "href": "https://{{tenant}}.auth0.com/form?request_uri=urn:ietf:params:oauth:request_uri:form_9tBrKx",
      "expires_in": 600
    }]
  }

// App opens WebView. User fills and submits form. Auth0 processes via Forms API.
// Redirects to: myapp://callback  ← no tokens
//
// AMENDED: this was action:interaction:form:verify:v1, an action the server never offered.
// Resume on the action that was in next[], like every other leg.

POST /e/authorize
{
  "auth_session": "eyJ...(form-pending)",
  "action": "action:interaction:form:v1"
}

→ 200 { "authorization_code": "eyJ..." }
```

---

### Post-login Redirect (Actions)

```
POST /e/authorize
{
  "auth_session": "eyJ...(post-authn)",
  "action": "action:verify:password:v1",
  "password": "<USER_PASSWORD>"
}

→ 403 {
    "error": "redirect_to_web",
    "request_uri": "urn:ietf:params:oauth:request_uri:web_5mNqPz",
    "auth_session": "eyJ...(redirect-pending)",
    "next": [{
      "action": "action:interaction:web:v1",
      "href": "https://{{tenant}}.auth0.com/continue?request_uri=urn:ietf:params:oauth:request_uri:web_5mNqPz&redirect_to=https://myapp.com/verify",
      "expires_in": 600
    }]
  }

// Auth0 /continue validates request_uri, redirects to customer URL:
//   https://myapp.com/verify?state=urn:ietf:params:oauth:request_uri:web_5mNqPz
//
// Customer endpoint completes interaction, redirects back:
//   https://{{tenant}}.auth0.com/continue?state=urn:ietf:params:oauth:request_uri:web_5mNqPz
//
// Auth0 detects embedded context, advances auth_session.
// Redirects to: myapp://callback

POST /e/authorize
{
  "auth_session": "eyJ...(redirect-pending)",
  "action": "action:interaction:web:v1"
}

→ 200 { "authorization_code": "eyJ..." }
```

---

## Composability: Chained Web Interactions

| Sequence | When it happens |
| --- | --- |
| Identification → CAPTCHA → password (native) → MFA (native) | Bot risk fires; rest of auth is fully in-app |
| Federation (web) → MFA (native) | Enterprise SSO followed by TOTP or push MFA in-app |
| Password (native) → Post-login form (web) → Code | Native auth followed by Actions progressive profiling |
| Federation (web) → Post-login form (web) | Enterprise login followed by an Actions form |

---

## Abandonment and Recovery

Any web leg can be abandoned — the user closes the WebView, the device goes offline, the app is backgrounded, or the coordination reference TTL expires. The recovery model is the same across all cases.

### The recovery pattern

The app always holds an `auth_session`. When the user returns, it submits the same `auth_session` back to `/e/authorize`:

```
POST /e/authorize
{
  "auth_session": "eyJ...(web-leg-pending)",
  "action": "<whatever the app last received in next[]>"
}
```

The server decodes the `auth_session`, inspects the pipeline state, and responds with the current `next[]`:

- **Coordination reference still valid** — server returns same action with a refreshed `href` (new coordination reference, same type of interaction).
- **Coordination reference expired** — server still returns the same action, generates a fresh coordination reference, issues a new `auth_session` with the new opaque reference. Indistinguishable from the original response.
- `auth_session` itself expired — server returns an error. The app must restart the flow.

### What the server never does on recovery

- Does not require the app to remember the previous `href` or `request_uri`.
- Does not expose internal pipeline state in the error response.
- Always returns the full `next[]` array reflecting where the pipeline actually is.

### Implications per flow type

| Flow | Recovery behaviour |
| --- | --- |
| CAPTCHA | New coordination reference; new CAPTCHA challenge. No user data to preserve. |
| Federation | New coordination reference; IDP redirect restarts. Active SSO session at IDP may complete silently. |
| Post-login form | New coordination reference; new journey created (new `txn`). Form presented fresh — no partial state persisted. |
| Post-login redirect | New coordination reference; customer endpoint receives a new `state`. Must not assume continuity from a prior visit. |

The `auth_session` encodes **where the pipeline is**, not the web-leg artifact. Recovery is always possible until `auth_session` expires.

---

## Open Questions

1. ~~**Resume action name for federation**~~ — **RESOLVED.** The app resumes on the connection-specific action it was offered, `authn:federated:google-oauth2:v1`. The alternative floated here — a distinct `action:interaction:federation:v1`, keeping `authn:*` strictly for capability declaration — was rejected because it reintroduces the very split being removed from forms: a resume id that differs from the offered id, which forces `next[]` to stop being a literal allow-list and become a mapping table. One rule for all four legs beats a tidier namespace.
2. **Parameters in the federation** `href` — current design passes only `request_uri`. Confirm whether Auth0's `/authorize` can accept `request_uri` as a standalone parameter or still requires `client_id` explicitly. If `client_id` is required, add it to the href — the Redis record remains the source of truth.
3. **HRD without an identifier** — for clients specifying `connection` explicitly, confirm `authn:federated:<connection>:v1` is returned in `next[]` when `conn !== null` is satisfied by the explicit param.
4. `auth_session` TTL during the federation web leg — an enterprise IDP login can be slow. Define the TTL policy and align with the CAPTCHA TTL policy.
5. **Callback scheme** — decide whether each web leg type uses a separate callback scheme or a single `myapp://callback` with a type discriminator.
