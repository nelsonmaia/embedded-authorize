# Bot Detection Challenge for Embedded Authorize

## Context

The embedded authorize endpoint (`/e/authorize`) is used by **public clients** as defined by the [OAuth 2.0 for First-Party Applications](https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/) specification. Public clients cannot hold static credentials, which exposes them to attacks such as **client impersonation** and **credential stuffing**. While [App Attestation](https://oktainc.atlassian.net/wiki/spaces/IAMPS/pages/986220312/App+Attestation+Product+Architecture+Overview) mitigates some of this risk, its implementation requires changes to the client (native app binary and SDK versions), adding significant adoption complexity for customers.

Security in embedded authentication is achieved through **defense in depth** — multiple overlapping layers of protection, so that the failure of any single layer does not result in a full breach. This is a well-established security principle (see [OWASP Defense in Depth](https://cheatsheetseries.owasp.org/cheatsheets/Defense_in_Depth_Cheat_Sheet.html) and [NIST SP 800-53 SC-5 / SI-3](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf)).

In the Auth0 embedded program, the following layers apply:

### 1. Tenant ACLs

Traffic policy enforced at the **Auth0 Edge** before any request reaches authentication logic. Protects against denial-of-service, rate-limit exhaustion, and unauthorized application registration. Supports monitoring mode for passive validation before enforcement. Scope is network/request-level only — not a substitute for authentication-layer controls. [Docs](https://auth0.com/docs/secure/tenant-access-control-list)

### 2. Brute Force Protection

Counts failed login attempts per IP-user pair. Blocks the originating IP after a configurable threshold (default: 10 attempts) and can optionally lock the account. Blocks expire automatically after 30 days or are cleared via password reset. Key limitation: **IP-based by default**, which means distributed attacks rotating across many IPs — cheap and common in credential-stuffing campaigns, as seen in recent Starbucks attacks with hundreds of source IPs — are not inherently blocked. Complement with account lockout policies and anomaly detection for stronger coverage. [Docs](https://auth0.com/docs/secure/attack-protection/brute-force-protection)

### 3. Suspicious IP Throttling

Blocks an IP that produces a high volume of failed logins or signups across multiple accounts within a day. Returns HTTP 429. More effective than per-user brute force for detecting **spray attacks** (low-and-slow attempts across many accounts from one IP), but still IP-centric — same limitation applies for rotating-IP attacks. [Docs](https://auth0.com/docs/secure/attack-protection/suspicious-ip-throttling)

### 4. App Attestation

Uses platform attestation APIs (Apple DeviceCheck, Android Play Integrity) to verify requests originate from a legitimate, unmodified app binary. Significantly raises the bar for client impersonation. Does not protect web apps. Requires the customer to adopt new SDK versions and update their native app — adds complexity to the customer integration path. [Architecture](https://oktainc.atlassian.net/wiki/spaces/IAMPS/pages/986220312/App+Attestation+Product+Architecture+Overview)

### 5. Bot Detection

Uses ML models to identify patterns in login, signup, and password-reset traffic that signal bot activity. When triggered, challenges the user with a verification step (Auth Challenge by default; configurable to hCaptcha, reCAPTCHA, or Simple CAPTCHA). Detection threshold is configurable: Low / Medium / High. Key limitation: **tightly coupled to Universal Login's state machine** — the CAPTCHA challenge cannot be completed natively in an embedded flow. The user must be redirected to a browser/hosted page, breaking the in-app experience. Enterprise and social connections are not supported at all. Customers must configure Universal Login even if they intend to use only embedded login. [Docs](https://auth0.com/docs/secure/attack-protection/bot-detection) · [Native app behavior](https://auth0.com/docs/secure/attack-protection/bot-detection/bot-detection-native-apps)

## Bot Detection: Current Limitations in Embedded Flows

Bot detection today is fully supported only in Universal Login. For applications not using UL:

| Flow | Bot Detection status |
| --- | --- |
| Universal Login | ✅ Full support — CAPTCHA inline |
| Resource Owner Password / direct API | ⚠️ No CAPTCHA support — challenge requires interactive browser |
| Embedded authorize (`/e/authorize`) | ⚠️ No native support — CAPTCHA cannot be rendered natively |
| Native apps (embedded path) | ⚠️ Must catch `requires_verification` and pivot to a WebAuth (UL) session — credentials re-entry required, in-app flow breaks |
| Enterprise / social connections | ❌ Not supported |

The current Auth0 guidance for native apps using direct API flows is to catch the `requires_verification` exception and open Universal Login — which forces users to re-enter their username and password. This is the exact experience the embedded program is designed to eliminate.

As documented in the [Identity Security + Embedded Authorize discovery](https://oktainc.atlassian.net/wiki/spaces/A0IS/pages/1032065648/Discovery+Identity+Security+Embedded+Authorize), Bot Detection is planned for **Phase 3 (GA)** and is a **LARGE effort** for both the Embedded and Identity Security teams. The core challenges are:

- Untangling the CAPTCHA state machine from UL prompts
- Validating that ML models perform adequately on embedded traffic (which uses different log event type codes than UL — retraining may be required)
- Deciding the native challenge mechanism (CAPTCHA SDK, attestation, or redirect\_to\_web)

**Important distinction:** Bot detection and CAPTCHA are two separate things. Bot detection is the ML-based signal assessment. CAPTCHA is one possible response action when the assessment fires. The solution below focuses on making the CAPTCHA *response* work in embedded flows via `redirect_to_web` without breaking the session or forcing credential re-entry.

## `redirect_to_web` in the OAuth First-Party Apps Spec

The [OAuth 2.0 for First-Party Applications](https://datatracker.ietf.org/doc/draft-ietf-oauth-first-party-apps/) spec explicitly defines `redirect_to_web` (HTTP 403, `"error": "redirect_to_web"`) as the mechanism for cases where the authorization server cannot complete the flow natively. The response may include a `request_uri` (via PAR / [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126)); the client opens a system browser to `/authorize?request_uri=...`.

This is the spec-aligned path for surfacing a CAPTCHA challenge in embedded flows. Critically, when implemented through `auth_session`, the `redirect_to_web` handoff **preserves session state** — meaning the CAPTCHA page is isolated to just the challenge, and the user does not re-enter credentials. This is fundamentally different from the current Auth0 fallback, which sends users back to a full Universal Login page.

The same `request_uri` coordination reference pattern is used across all redirect-to-web cases — CAPTCHA, federation, and post-login Actions forms. See [Redirect to Web Flows in Embedded Authorization](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1046249511/Redirect+to+Web+Flows+in+Embedded+Authorization) for the full architecture and rationale behind this design.

## Bot Detection Response Modes for Embedded Authorize

**Scope:** This solution applies exclusively to the `/e/authorize` endpoint. It does not cover direct embedded grant types at `/oauth/token` — Resource Owner Password Grant, native passkey grant, native social token exchange (Apple, Google), or passwordless OTP grant. Those flows have separate bot detection considerations and are not addressed here.

Any signal submitted by the client cannot be trusted — it can be tampered by an attacker. Detection must be server-side. The client only declares its capabilities and responds to server-issued challenges.

The product would expose three configurable response modes when bot activity is detected in an embedded flow. Customers choose which mode applies per application or tenant — the same flexibility Bot Detection already offers for Universal Login (Auth Challenge, CAPTCHA provider, block).

### Adaptive

CAPTCHA fires **before credential submission** — immediately after email identification, when risk signals exceed the configured threshold. The user proves humanness once; the full credential flow (password, MFA, passkey) continues natively with no further browser step.

#### Coordination reference and binding model

When CAPTCHA fires, the server generates an **opaque coordination reference** — a short random pointer stored in Redis, not a JWT or JWE. The Redis record holds all binding context; the reference itself carries nothing:

```
Redis key: urn:ietf:params:oauth:request_uri:tk6TqMkJ_-kNGZxlYgGc5A

{
  "auth_session_ref": "<hash of auth_session>",
  "status": "PENDING",
  "ip": "203.0.113.42",
  "asn": "AS15169",
  "ttl": 90s
}
```

The `request_uri` in the `href` URL is just this Redis key. Even if intercepted, it is worthless on another machine — the CAPTCHA page validates IP/ASN match before accepting the challenge. The callback URL carries **no token at all** — it is a signal to close the browser. The `auth_session` advancement happens entirely server-side.

**Is the cookie needed if IP and ASN are already bound?**      
IP/ASN binding is the minimum security floor and is sufficient to prevent cross-machine/cross-network attacks. Since Android Chrome Custom Tabs cannot do cookie injection, IP/ASN is already the only control on that platform. The cookie is an optional per-device hardening layer — valuable on iOS (where `ASWebAuthenticationSession` shares the Safari cookie store) and SPA (same browser context), but not a hard requirement. The security model must work on IP/ASN alone.

**Why** `request_uri` **format and not** `state`**?**      
[RFC 9126](https://www.rfc-editor.org/rfc/rfc9126) (PAR) established `urn:ietf:params:oauth:request_uri:<opaque>` as the standard way to express a server-side opaque reference in OAuth. We borrow the format — not the full PAR protocol — because it is already a recognized concept and avoids any collision with the OAuth2 `state` parameter, which is a separate anti-CSRF mechanism used in browser-based authorization flows. Calling this reference "state" would conflate two distinct things. The `request_uri` is the Redis lookup key — the server needs it to find which session this CAPTCHA belongs to — and acts as a CSRF control, preventing another page from triggering a solve against an arbitrary session. The cookie is optional hardening on top; `request_uri` + IP/ASN binding is the foundation.

#### auth\_session binding post-CAPTCHA

After CAPTCHA is cleared, the `auth_session` itself must be bound to the IP/ASN that was present during the CAPTCHA solve. This closes a critical gap: without this binding, an attacker could farm CAPTCHA on one network, then use the cleared `auth_session` from a different machine to run credential stuffing.

Two rules enforced after CAPTCHA clearance:

1. **IP/ASN binding stamped on the auth\_session** — when the app resumes at step 3 (`action:interaction:captcha:verify:v1`), Auth0 stamps the validating IP/ASN onto the `auth_session`. Subsequent credential submissions from a different IP/ASN are rejected and require a fresh CAPTCHA.
2. **CAPTCHA clearance is single-use across credential attempts** — the clearance is consumed on the first credential submission. A wrong password resets the `auth_session` to captcha-required, not to the credential step. An attacker cannot solve CAPTCHA once and then try many passwords against the same session; each attempt requires re-CAPTCHA.

**Identifier binding:** The identifier (email) is already sealed into the `auth_session` when CAPTCHA fires. If the identifier changes — which requires re-initiating the flow — a new `auth_session` is issued and the CAPTCHA gate resets. Binding is implicit, not an extra check.

#### Binding controls across the handoff

Each interaction point in the flow has its own attack surface and binding control:

| Interaction | Threat | Control |
| --- | --- | --- |
| App → CAPTCHA page | URL sent to another machine/device | `request_uri` is an opaque Redis key — carries no auth material; IP/ASN validated on page load; optional nonce cookie for per-device binding (iOS/SPA only) |
| CAPTCHA solve → Auth0 server | Fake or replayed CAPTCHA result | Browser POSTs result directly to Auth0 (same origin) — no redirect needed; Auth0 updates Redis |
| Auth0 server → App (callback) | Token interception | Callback carries no token (`myapp://captcha-done`) — nothing to intercept or replay |
| App resumes `/e/authorize` | Cleared session used from a different network | Redis record single-use, deleted on consumption; **IP/ASN stamped onto** `auth_session` at this point — all subsequent calls in this session must come from the same network |
| Credential submission | Guessing many passwords with one solved CAPTCHA | CAPTCHA clearance consumed on first attempt — wrong password resets to captcha-required, not back to credential step |

Cookie injection per platform — the application can do this directly; the SDK makes it automatic:

- **iOS:** Set cookie in `HTTPCookieStorage.shared` before opening `ASWebAuthenticationSession` (iOS 13+ shares the Safari cookie store with the app)
- **Android (Chrome Custom Tabs):** ⚠️ Not supported — Chrome Custom Tabs uses Chrome's own cookie store, which the app cannot write to. Android apps using a `WebView` directly can inject cookies via `CookieManager`, but Chrome Custom Tabs cannot.
- **SPA:** Same browser context — cookie is co-located automatically

#### HTTP flow — bot detection fires after identification, before any credential action

The example uses password as the credential step, but this applies to any factor (`action:verify:password:v1`, `authn:passkey:v1`, `authn:ns:apple:v1`, etc.) — the CAPTCHA challenge fires after the identifier is established, regardless of which credential follows.

```
// Step 1: Initial call — identify by email + declare capabilities.

POST /e/authorize
{
  "client_id": "{{client_id}}",
  "scope": "{{scope}}",
  "audience": "{{audience}}",
  "identifier": "alice@example.com",
  "capabilities": [
    "action:identify:email:v1",
    "action:verify:password:v1",
    "authn:federated:v1"
  ]
}

// Bot risk detected. Server generates opaque request_uri, stores in Redis (PENDING, IP/ASN bound, 90s TTL).
// auth_session advances to a captcha-pending step — its hash is stored in the Redis record
// so the server can locate the record when the app resumes.

→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(captcha-pending)",
    "next": [{
      "action": "action:interaction:captcha:verify:v1",
      "href": "https://{{tenant}}.auth0.com/captcha?request_uri=urn:ietf:params:oauth:request_uri:tk6TqMkJ_-kNGZxlYgGc5A"
    }]
  }


// Step 2: Client injects nonce cookie (iOS/SPA only), then opens browser.
//   The application can do this directly; the SDK handles it automatically.
//
//   iOS:     HTTPCookieStorage.shared.setCookie(...) → ASWebAuthenticationSession (shared Safari store)
//   Android: Chrome Custom Tabs cannot receive injected cookies — IP/ASN binding is the control here.
//            Android WebView can use CookieManager.getInstance().setCookie(...) if the app controls the WebView.
//   SPA:     window.location / window.open() — cookie already co-located in the same browser context
//
// CAPTCHA page loads → Auth0 validates:
//   - request_uri exists in Redis and is PENDING
//   - request IP/ASN matches Redis record
//   - nonce cookie is present (iOS / SPA only)
//
// User solves CAPTCHA → browser POSTs result directly to Auth0 (same origin, no redirect).
// Auth0 validates CAPTCHA token with provider → updates Redis: PENDING → SOLVED.
// Browser redirects to: myapp://captcha-done    ← no token, nothing in the URL.
// Client closes the browser.


// Step 3: App resumes the embedded flow with the same auth_session — no request_uri, no token.
// Server hashes auth_session → finds Redis record → status SOLVED → advances session.
// Server stamps IP/ASN onto auth_session — credential submission must come from the same network.
// CAPTCHA clearance is marked single-use: wrong password resets to captcha-required, not credential step.
// Redis record deleted (single-use).

POST /e/authorize
{
  "auth_session": "eyJ...(same as before)",
  "action": "action:interaction:captcha:verify:v1"
}

// Flow resumes — server returns whatever is next for this user + connection.
→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(advanced, IP/ASN stamped)",
    "next": [{ "action": "action:verify:password:v1" }]
  }
// Credential flow continues natively — no further browser step.


// Step 4: App submits password (or any other next[] action) natively.

POST /e/authorize
{
  "auth_session": "eyJ...(advanced)",
  "action": "action:verify:password:v1",
  "password": "<USER_PASSWORD>"
}

→ 200 { "authorization_code": "eyJ..." }
// App exchanges authorization_code at /oauth/token as usual.

// If password is wrong — CAPTCHA clearance is consumed; attacker must re-solve CAPTCHA.
→ 403 {
    "error": "insufficient_authorization",
    "error_description": "invalid_identifier_or_password",
    "auth_session": "eyJ...(captcha-required)",
    "next": [{
      "action": "action:interaction:captcha:verify:v1",
      "href": "https://{{tenant}}.auth0.com/captcha?request_uri=urn:ietf:params:oauth:request_uri:newRef9xKmPqRt_2yBvZ"
    }]
  }

// If MFA is required:
→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(advanced)",
    "next": [{ "action": "action:verify:otp:v1", "channel_description": "Authenticator app" }]
  }
// MFA continues natively — no further browser step.


// — CAPTCHA failed, Redis TTL expired, or IP/ASN mismatch —
// Auth0 shows error inline on the hosted page (retry available).
// On cancel: myapp://captcha-done?error=captcha_failed — client re-calls /e/authorize,
// server returns a fresh request_uri in next[].
```

#### Notes on TTL and Redis lifecycle

- **90s TTL** is a reasonable baseline — covers the CAPTCHA interaction time without leaving stale records. If the user is slow or abandons the page, the record expires and the app gets a fresh challenge on next attempt.
- **auth\_session TTL** is independent and longer. Redis records are short-lived; the auth\_session is the durable token that spans the full flow.
- **Future: configurable binding mode** — for customers where IP/ASN binding is too strict (mobile users switching networks mid-flow, certain enterprise proxy topologies): `botDetection.webChallenge.binding: "cookie+ip+asn" | "cookie+asn" | "cookie_only"`. Cookie-only is the minimum viable binding; removing the cookie entirely leaves the opaque `request_uri` as the only control, which is insufficient.

#### Honest limitations

CAPTCHA-solving services (human farms, \~$2/1000) mean that CAPTCHA is a **cost-raising friction layer**, not a cryptographic barrier. A sophisticated attacker can always outsource the human step. The controls above (IP/ASN binding, single-use clearance, server-side marking) significantly raise the cost and complexity of that attack, but do not eliminate it. App Attestation — validating the app binary before the flow starts — is the more robust long-term control for native apps, as it makes it much harder to run the SDK in an untrusted context at all.

This is the defense-in-depth principle described at the top of this document: no single layer is expected to be unbreakable. Tenant ACLs, brute force protection, suspicious IP throttling, App Attestation, and bot detection each raise the cost and narrow the attack surface. Adaptive is one layer in that stack — its value is that it forces human involvement at a cost that makes large-scale credential stuffing economically impractical, not that it makes individual attempts impossible.

### Customize with Actions

For customers who want to stay fully in-app and handle bot signals programmatically, this mode exposes bot detection assessments in the post-login Actions event object. Customers can decide whether to block, trigger MFA, trigger the hosted CAPTCHA, or allow.

**Why a new mechanism is needed:** Unlike UL flows, the embedded endpoint cannot silently issue a browser redirect. Any response that differs from a normal credential failure leaks an oracle — an attacker can distinguish "bot detected" from "wrong password" if the error shapes differ. This is the same enumeration risk documented in the [Starbucks early risk evaluation](https://oktainc.atlassian.net/wiki/spaces/IAML/pages/1001493642/Starbucks+Early+Risk+Evaluation+via+Custom+DB+Script+Context+IP+client_id), where a post-login `access_denied` was distinguishable from an `invalid_grant` credential failure.

**Proposed addition to the post-login event object:**

Currently `event.authentication.riskAssessment.assessments` includes: `AgentDetection`, `ImpossibleTravel`, `NewDevice`, `UntrustedIP`. A new `BotDetection` assessor would be added:

```json
{
  "riskAssessment": {
    "confidence": "high",
    "assessments": {
      "BotDetection": {
        "code": "bot_detected",
        "confidence": "high",
        "details": {
          "model": "credential_stuffing",
          "score": 0.94
        }
      }
    }
  }
}
```

**Customer Action example:**

```js
exports.onExecutePostLogin = async (event, api) => {
  const bot = event.authentication?.riskAssessment?.assessments?.BotDetection;

  if (bot?.code === "bot_detected" && bot?.confidence === "high") {
    // Deny silently — same error shape as a wrong credential, no oracle.
    api.access.deny("bot_detected", { asCredentialFailure: true });

    // Require MFA step-up instead of denying.
    // api.multifactor.enable("any");

    // Trigger the hosted CAPTCHA challenge — hands off to the Adaptive flow.
    // api.botDetection.challenge();

    // Allow but log for monitoring (passive mode during rollout).
    // api.access.allow();
  }
};
```

`api.access.deny(reason, { asCredentialFailure: true })` returns `insufficient_authorization / invalid_identifier_or_password` — the same shape as a failed credential, giving the attacker no signal that bot detection fired.

An alternative worth considering: make `{ asCredentialFailure: true }` the **default behavior** of `api.access.deny()` in embedded flows. Since embedded has a fundamentally different error contract than UL (no browser redirect on deny, no `access_denied` shape the client expects), credential-failure masking could be the right default for embedded rather than an opt-in. Customers who explicitly want an `access_denied` response in embedded could then opt out instead.

Customers using Customize with Actions who want to trigger the hosted CAPTCHA challenge (Adaptive flow) from within their Action — rather than relying on automatic detection — could call `api.botDetection.challenge()`. This would initiate the exact same Adaptive flow (request\_uri coordination reference, IP/ASN binding, server-side marking) but driven by the customer's own logic instead of the default threshold. The two modes become composable: detect with your own signals in the Action, then hand off to Auth0's CAPTCHA infrastructure to handle the challenge.

**HTTP flows — what the client sees for each Action decision**

**Timing difference from Adaptive:** Customize with Actions fires after credential submission — the password has already been collected before the Action evaluates the bot signal. Adaptive fires before any credential is submitted. This is a known trade-off of customer-controlled detection: the customer gets full signal control but the CAPTCHA (if triggered via `api.botDetection.challenge()`) happens later in the flow.

From an attacker's perspective this does not matter — both cases return the same `invalid_identifier_or_password` error regardless of whether the credential was correct or incorrect, so there is no oracle. In Adaptive (default hosted CAPTCHA), the experience is fully consistent and the attacker never reaches credential submission at all. In Customize with Actions, the customer accepts responsibility for that consistency — as long as `api.access.deny` uses `{ asCredentialFailure: true }`, the response shape is indistinguishable either way.

```
// Identify + submit password — always the same request shape regardless of mode.

POST /e/authorize
{ "client_id": "{{client_id}}", "identifier": "alice@example.com",
  "capabilities": ["action:identify:email:v1", "action:verify:password:v1"] }

→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...",
    "next": [{ "action": "action:verify:password:v1" }]
  }

POST /e/authorize
{ "auth_session": "eyJ...", "action": "action:verify:password:v1", "password": "<USER_PASSWORD>" }


// — Action calls api.access.deny("bot_detected", { asCredentialFailure: true }) —
// Bot denied silently. Response is identical to a wrong password — no oracle.
→ 403 {
    "error": "insufficient_authorization",
    "error_description": "invalid_identifier_or_password",
    "auth_session": "eyJ...(reset)",
    "next": [{ "action": "action:verify:password:v1" }]
  }


// — Action calls api.multifactor.enable("any") —
// Bot suspected but not denied — MFA step-up required before proceeding.
→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...",
    "next": [{ "action": "action:verify:otp:v1", "channel_description": "Authenticator app" }]
  }
// MFA continues natively — no browser step.


// — Action calls api.botDetection.challenge() —
// Hands off to the Adaptive CAPTCHA flow. Response is identical to what Adaptive returns.
→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(captcha-pending)",
    "next": [{
      "action": "action:interaction:captcha:verify:v1",
      "href": "https://{{tenant}}.auth0.com/captcha?request_uri=urn:ietf:params:oauth:request_uri:tk6TqMkJ_-kNGZxlYgGc5A"
    }]
  }
// From here: client opens browser, CAPTCHA is solved, auth_session advances server-side,
// client resumes /e/authorize — identical to the Adaptive flow.


// — Action allows (monitoring mode) —
// No intervention — normal completion.
→ 200 { "authorization_code": "eyJ..." }
```

### Block

Reject the request when bot activity is detected. No CAPTCHA, no signal exposed to the client — same error shape as any other denial. Simplest to configure. No recourse for false positives; legitimate users on flagged IPs or devices would be silently blocked with no path forward.

```
// Identify + submit password — same request shape as any embedded flow.

POST /e/authorize
{ "client_id": "{{client_id}}", "identifier": "alice@example.com",
  "capabilities": ["action:identify:email:v1", "action:verify:password:v1"] }

→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...",
    "next": [{ "action": "action:verify:password:v1" }]
  }

POST /e/authorize
{ "auth_session": "eyJ...", "action": "action:verify:password:v1", "password": "<USER_PASSWORD>" }

// Bot detected — request blocked. Same error shape as a wrong credential.
→ 403 {
    "error": "insufficient_authorization",
    "error_description": "invalid_identifier_or_password",
    "auth_session": "eyJ...(reset)",
    "next": [{ "action": "action:verify:password:v1" }]
  }
// Client cannot distinguish this from a failed login attempt.
```

## Web SDK Considerations

The Adaptive flow described above assumes a native client opening a system browser (`ASWebAuthenticationSession` / Chrome Custom Tabs). For **web SDKs**, opening a separate browser window is not the right pattern — the CAPTCHA challenge should be rendered **inline within the page** by the SDK itself, without a browser handoff.

The SDK would detect from the platform context (native vs. web) which path to take:

- **Native SDK** — follows the `redirect_to_web` flow described above: injects cookie (iOS), opens system browser, server-side Redis marking, `captcha-done` callback
- **Web SDK** — renders the CAPTCHA UI component inline in the page; the CAPTCHA result is POSTed directly to Auth0 from the same browser context, auth\_session advances server-side, flow resumes without any browser navigation

This keeps the embedded experience fully in-page for web customers while preserving the same server-side marking model.

**TODO:** Investigate how DX Flows API and DX Flows SDKs handle CAPTCHA today — both repos may have existing patterns or components for inline CAPTCHA rendering that could be referenced or reused here rather than building from scratch. Repos to check: `auth0/dx-flows-api`, `auth0/dx-flows-sdk` (or equivalent) — confirm repo names and relevant CAPTCHA integration paths before design is finalized.

## Complementary Layer: App Attestation

App Attestation is not a response mode — it is an upstream gate that reduces the bot surface before any credential exchange happens. By validating the app binary at the client-identity layer, it significantly raises the cost of impersonation and reduces the volume of bot traffic that reaches the detection models at all. Best used alongside any of the three modes above, not as a replacement. See [App Attestation architecture](https://oktainc.atlassian.net/wiki/spaces/IAMPS/pages/986220312/App+Attestation+Product+Architecture+Overview).

## Open Questions

1. **How do we configure bot detection separately for embedded vs. UL?** Currently bot detection is a single tenant-level setting. Embedded flows will need per-flow or per-application configuration granularity — a customer using both UL and embedded should be able to set different thresholds or response actions for each.
2. `auth_session` **TTL during the browser handoff** — the Redis record has its own short TTL (90s); the `auth_session` has a separate, longer TTL. Whether the `auth_session` clock pauses or continues during the CAPTCHA step must be agreed with Security before EA. CAPTCHA typically takes 10–30 seconds — well within any reasonable session TTL — but the policy should be explicit and consistent with the federation handoff decision in M3 D2.
3. **ML model validity on embedded traffic** — embedded flows produce different log event type codes than UL. Models trained on UL data may not perform with the same efficacy on embedded traffic. Validation is needed (cc. Identity Security / Catherine Razeto) before enabling bot detection on embedded at any confidence level.
4. **Embedded vs. UL configuration surface** — bot detection settings, CAPTCHA provider choice, threshold levels, and binding mode are all currently UL-scoped. Defining what is shared vs. per-flow is a prerequisite for GA. A customer using both UL and embedded should be able to configure different response modes for each.

## Resources

- [Discovery: Embedded Authorize + CAPTCHA POC](https://oktainc.atlassian.net/wiki/spaces/A0IS/pages/1049198657/Discovery+Embedded+Authorize+CAPTCHA+POC) — proof of concept validating the `redirect_to_web` model proposed in this page.
