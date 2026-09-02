# Redirect to Web Flows in Embedded Authorization

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
  ← 403 { error: "insufficient_authorization",
           auth_session: "...",
           next: [{ action: "...", href: "..." }] }

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

**The pipeline continues natively after the web leg.** After resuming, the server returns the next required action — MFA, another form, etc. — or issues the authorization code if the pipeline is complete.

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
| Native Social | `authn:ns:google:v1` — no `href` | `authn:ns:google:v1` with `idp_artifact` | N/A — fully native |
| Post-login form (Actions) | `action:interaction:form:v1` with `href` | `action:interaction:form:verify:v1` | `request_uri` in URL; `auth_session_ref` on resume |
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
  "capabilities": [
    "action:identify:email:v1",
    "authn:federated:v1"
  ]
}

// alice@company.com maps to an enterprise SAML connection via HRD.
// Server generates the coordination reference immediately and returns href.
→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(contains opaque reference, federation-pending)",
    "next": [{
      "action": "authn:federated:company-saml:v1",
      "href": "https://{{tenant}}.auth0.com/authorize?request_uri=urn:ietf:params:oauth:request_uri:fed_8xKpQrT2"
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
→ 403 {
    "error": "redirect_to_web", // According to the Spec
    "request_uri": "urn:ietf:params:oauth:request_uri:fed_8xKpQrT2" // Part of the Spec
    "auth_session": "eyJ...(federation-pending)",
    "next": [{
      "action": "authn:federated:google-oauth2:v1",
      "href": "https://{{tenant}}.auth0.com/authorize?request_uri=urn:ietf:params:oauth:request_uri:fed_8xKpQrT2"
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
→ 403 { "next": [{ "action": "action:interaction:form:v1", "href": "..." }] }

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

// App authenticates natively with Google SDK, receives access_token
// It depends on the Native SDKs, might be id_token or another artifact

POST /e/authorize
{
  "auth_session": "eyJ...",
  "action": "authn:ns:google:v1",
  "id_token": "<google_access_token>",
}

// Continue into the pipelien till completion

// If MFA required:
→ 403 { "next": [{ "action": "action:challenge:oob:v1" }] }

// If post-login form required:
→ 403 { "next": [{ "action": "action:interaction:form:v1", "href": "..." }] }

// If pipeline complete:
→ 200 { "authorization_code": "eyJ..." }
```

> **Provider artifacts:** Google → access token · Apple → authorization code (`http://auth0.com/oauth/token-type/apple-authz-code`) · Facebook → access token

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
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(form-pending)",
    "next": [{
      "action": "action:interaction:form:v1",
      "href": "https://{{tenant}}.auth0.com/form?request_uri=urn:ietf:params:oauth:request_uri:form_9tBrKx"
    }]
  }

// App opens WebView. User fills and submits form. Auth0 processes via Forms API.
// Redirects to: myapp://callback  ← no tokens

POST /e/authorize
{
  "auth_session": "eyJ...(form-pending)",
  "action": "action:interaction:form:verify:v1"
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
    "next": [{
      "action": "action:interaction:web:v1",
      "href": "https://{{tenant}}.auth0.com/continue?request_uri=urn:ietf:params:oauth:request_uri:web_5mNqPz&redirect_to=https://myapp.com/verify"
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

1. **Resume action name for federation** — when the app resumes it sends the connection-specific action (e.g., `"action": "authn:federated:google-oauth2:v1"`). Confirm this is the agreed convention, or whether resume should use a distinct action like `action:interaction:federation:v1` to keep `authn:*` strictly for initial capability declaration.
2. **Parameters in the federation** `href` — current design passes only `request_uri`. Confirm whether Auth0's `/authorize` can accept `request_uri` as a standalone parameter or still requires `client_id` explicitly. If `client_id` is required, add it to the href — the Redis record remains the source of truth.
3. **HRD without an identifier** — for clients specifying `connection` explicitly, confirm `authn:federated:<connection>:v1` is returned in `next[]` when `conn !== null` is satisfied by the explicit param.
4. `auth_session` TTL during the federation web leg — an enterprise IDP login can be slow. Define the TTL policy and align with the CAPTCHA TTL policy.
5. **Callback scheme** — decide whether each web leg type uses a separate callback scheme or a single `myapp://callback` with a type discriminator.
