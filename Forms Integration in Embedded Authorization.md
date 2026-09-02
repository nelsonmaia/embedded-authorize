# Forms Integration in Embedded Authorization

> Working document — tied to the redirect-to-web and native SDK paths for post-login Actions forms.  
> Cross-reference the PoC in PR [atko-cic/auth0-server#18339](https://github.com/atko-cic/auth0-server/pull/18339).  
> Part of the [Redirect to Web Flows in Embedded Authorization](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1046249511/Redirect+to+Web+Flows+in+Embedded+Authorization) architecture.

Two integration paths exist for surfacing a post-login Actions form in an embedded flow. Both use the same server-side machinery (DX Flows journey, coordination reference, `auth_session` binding). They differ only in **where the form is rendered** and **what the server returns in **`next[]`.

|  | Redirect to Web | Native Form SDK |
| --- | --- | --- |
| Render location | Auth0 hosted form page (WebView) | In-app, using the Form SDK |
| `next[]` response | `action:interaction:form:v1` + `href` | `action:interaction:form:v1` + form payload (no `href`) |
| Client capability required | none (default) | `action:interaction:form:native:v1` |
| SDK dependency | none | Native Form SDK |
| Status | Available | **Beta only** |

> **Note:** The Native Form SDK path is currently in beta. Redirect to Web is the recommended path for production use until native SDK support reaches GA.

---

## Common Foundation

Both paths share the same server-side machinery: a single `dxFlowsApi.createJourney(...)` call creates the journey; a `txn` UUID binds it to the coordination reference; the `auth_session` carries the opaque reference across the web or native leg; and the same resume check closes the loop regardless of which rendering path was used.

### What the PoC taught us

[PR atko-cic/auth0-server#18339](https://github.com/atko-cic/auth0-server/pull/18339) ("form\_required for embedded /oauth/token flows — Part 1") proved the Forms API integration end-to-end for native token flows (ROPG, passwordless OTP, native social, native passkeys). The key learning: **creating a journey is a single API call, and the binding key is a server-generated **`txn` UUID stored as `state`.

#### The one call that matters

```js
await dxFlowsApi.createJourney(
  tenantName,
  promptId,          // form template id from api.prompt.render() → rulesContext.renderCustomPrompt.promptId
  { state: txn },    // promptContext — binding UUID; this is the lookup key on resume
  triggerContext,    // user/client/org/connection/protocol/grantType snapshot
  promptOptions,     // variables the Action passed to the form
  expirationDate     // TTL for the journey
);
```

`state` = `txn` (UUIDv4, server-generated). The Forms SDK and the DX Flows API use this value to look up and advance the journey. On resume, the server calls `dxFlowsApi.getJourney(tenantName, txn)` and checks `status === COMPLETED`.

#### `triggerContext` — no UL session in embedded flows

UL forms use `mappers.buildTriggerContext()` which assumes a transaction/session object. Embedded flows have no such session. The PoC builds it directly from grant-time inputs:

```js
function buildTriggerContext(err, req) {
  return {
    user: err.user,
    client: { client_id: req.user.clientID },
    organization: err.organization,
    connection: { name: err.connectionName },
    protocol: err.protocol,
    grantType: err.grantType,
  };
}
```

For the `/e/authorize` path, the equivalent inputs come from the `auth_session` (user identified, connection resolved, grant in progress) at the point the pipeline emits `action:interaction:form:v1`.

#### What lives where

| Data | Where it lives |
| --- | --- |
| Journey binding key (`txn`) | In the journey itself (as `state`) AND in the Redis coordination reference |
| Form template id (`form_id`) | In the Redis coordination reference; passed to `createJourney` as `promptId` |
| Auth context for resume | In `auth_session` — self-contained, carries its own context |
| Journey completion status | DX Flows API — `dxFlowsApi.getJourney(tenantName, txn).status` |

### On `action:interaction:form:v1` emission — shared server steps

Regardless of which rendering path is used, the server always:

```
1. Generate txn = UUID v4
2. Build triggerContext from auth_session (user, client, connection, protocol, grantType)
3. Read formId and promptOptions from the Actions pipeline renderCustomPrompt command
4. Call dxFlowsApi.createJourney(tenant, formId, { state: txn }, triggerContext, promptOptions, expirationDate)
5. Store in Redis coordination reference:
   {
     "auth_session_ref": "<hash of auth_session>",
     "status":           "PENDING",
     "type":             "form",
     "client_id":        "<client_id>",
     "form_id":          "<formId>",
     "txn":              "<txn>",
     "ttl":              600s
   }
```

The `request_uri` URN format (`urn:ietf:params:oauth:request_uri:<opaque>`) is borrowed from [RFC 9126](https://www.rfc-editor.org/rfc/rfc9126) (PAR) — the same pattern used across all redirect-to-web cases in embedded flows. See [Redirect to Web Flows in Embedded Authorization](https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1046249511/Redirect+to+Web+Flows+in+Embedded+Authorization) for the full coordination reference model.

What goes in `next[]` after this point is where the two paths diverge.

### On resume — shared verification steps

```
1. Decode auth_session → extract opaque coordination reference
2. Look up Redis record → get txn, form_id, auth_session_ref
3. Verify auth_session_ref matches inbound auth_session
4. Call dxFlowsApi.getJourney(tenantName, txn)
5. Assert journey.status === "COMPLETED"
6. Assert journey.form_id === form_id
7. Advance Actions pipeline
8. Continue /e/authorize response
```

The server performs these checks identically whether the form was rendered in a WebView or natively by the Form SDK. The resume contract is the same either way.

---

## Forms via Redirect to Web

The server returns an `href` in `next[]`. The app opens a WebView. Auth0's hosted form page — the same machinery UL uses today — renders and submits the form. No SDK required in the app.

### How it simplifies the integration

[PR #18339](https://github.com/atko-cic/auth0-server/pull/18339) targets native SDK rendering: the SDK receives a `form_token`, decodes the claims, and calls `Auth0Forms.embed(...)` inline — the form renders inside the app without a WebView. This requires `form_token` (iron-sealed), `FORM_SECRET`, and SDK-side rendering infrastructure.

**Redirect-to-web uses none of that.** The `href` points to Auth0's hosted form page:

```
UL forms today:
  Auth0 /u/custom-prompt/:promptId → page loads Auth0Forms SDK → embed(promptId, container, { state }) →
  user submits → Forms SDK posts to DX Flows API → journey COMPLETED →
  Auth0 POST handler advances pipeline → server renders next UL prompt or issues the code.

Redirect-to-web (embedded):
  Auth0 /form?request_uri=... → same form page → same Auth0Forms SDK → same journey completion →
  same POST handler advances pipeline →
  BUT: detects embedded context and deep-links back to app instead of rendering next UL prompt.
```

The app never touches the Forms SDK. The WebView does all of this.

| Concern | PoC (native rendering) | Redirect-to-web |
| --- | --- | --- |
| Journey creation | `dxFlowsApi.createJourney(...)` | Same |
| `form_token` | Required (SDK needs it to find the journey) | Not needed |
| Iron-seal / `FORM_SECRET` | Required | Not needed |
| SDK rendering | SDK embeds form in app UI | Hosted form page handles it |
| Resume mechanism | New endpoint or grant type consuming `form_token` | `/e/authorize` with `action:interaction:form:verify:v1` |
| Resume auth context | Carried in `form_token.ses` (iron-sealed) | Carried in `auth_session` (self-contained) |

### HTTP flow

```
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

// App opens WebView with href.
// Auth0 hosted form page: loads Auth0Forms SDK → renders form → user submits →
// DX Flows API marks journey COMPLETED → detects embedded context → deep-links back.
// Callback: myapp://callback  ← no tokens

POST /e/authorize
{
  "auth_session": "eyJ...(form-pending)",
  "action": "action:interaction:form:verify:v1"
}

→ 200 { "authorization_code": "eyJ..." }
```

### Open questions

1. **New **`/form` endpoint vs. extending `/u/custom-prompt` — Option A: thin new endpoint that pre-processes the coordination reference and renders the existing template, overriding the completion redirect. Option B: extend `/u/custom-prompt/:promptId` to accept `request_uri`. Option A is preferred for isolation.
2. **Deep-link trigger mechanism** — the POST handler in `custom-form/handlers/post.js` needs to detect embedded context and issue a deep-link instead of rendering the next UL prompt. Confirm how the handler reads this — likely via `request_uri` threaded through the UL session state.
3. **Journey data access in Actions** — confirm `dxFlowsApi.getJourney()` returns submitted field values in a shape the resumed Actions pipeline can consume.

---

## Forms via Native Form SDK

> **Beta only.** This path requires the Native Form SDK, which is currently in beta. The redirect-to-web approach is the recommended production path until native SDK support reaches GA.

The client declares `action:interaction:form:native:v1` in its `capabilities`. The server detects this and returns the form payload directly in `next[]` instead of an `href`. The app renders the form inline using the Native Form SDK — no WebView.

### What's different in `next[]`

```
// Without native capability — redirect path:
"next": [{
  "action": "action:interaction:form:v1",
  "href": "https://{{tenant}}.auth0.com/form?request_uri=urn:ietf:params:oauth:request_uri:form_9tBrKx"
}]

// With native capability declared:
"next": [{
  "action": "action:interaction:form:v1",
  "form_id": "<form_id>",
  "state": "<txn>"
}]
```

Journey creation, `auth_session` binding, and the Redis coordination reference are identical to the redirect-to-web path. The server just omits the `href` construction and includes `form_id` + `state` directly so the Native Form SDK can initialize.

### HTTP flow

```
POST /e/authorize
{
  "client_id": "{{client_id}}",
  "auth_session": "eyJ...(post-authn)",
  "action": "action:verify:password:v1",
  "password": "<USER_PASSWORD>",
  "capabilities": [
    "action:interaction:form:native:v1"
  ]
}

→ 403 {
    "error": "insufficient_authorization",
    "auth_session": "eyJ...(form-pending)",
    "next": [{
      "action": "action:interaction:form:v1",
      "form_id": "<form_id>",
      "state": "<txn>"
    }]
  }

// App initializes the Native Form SDK with form_id and state.
// SDK renders form inline. User submits.
// SDK POSTs submission to DX Flows API → journey transitions PENDING → COMPLETED.
// App calls /e/authorize to resume.

POST /e/authorize
{
  "auth_session": "eyJ...(form-pending)",
  "action": "action:interaction:form:verify:v1"
}

→ 200 { "authorization_code": "eyJ..." }
```

### Open questions

1. **Exact payload shape** — confirm the field names the Native Form SDK expects. `form_id` and `state` are the minimum; check whether the SDK also needs `tenant`, `client_id`, or a token.
2. **Capability negotiation** — `action:interaction:form:native:v1` is a proposal. Confirm naming with the SDK team and align with the broader capability registry.
3. **SDK beta graduation criteria** — define what "GA" means for the Native Form SDK so this path has a clear promotion path out of beta.
4. **Fallback behavior** — if the client declares `action:interaction:form:native:v1` but the tenant has a form the SDK version doesn't support, should the server fall back to `href` or return an error? Define the degradation contract.
