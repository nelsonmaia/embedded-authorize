# The deployed console: the built app plus the tenant proxy it cannot work without.
#
# Both stages sit on the audited Wolfi base rather than node:22-alpine. The build stage matters as
# much as the runtime one: it produces artifacts that are copied forward, so it is part of the same
# supply chain. This is the digest the platform's auto-repair rebases onto, pinned here explicitly
# so the image that ships is the image described in this file.
#
# Nothing here needs a secret. The one thing to set is PLAYGROUND_ALLOWED_HOSTS — the exact tenant
# domains this deployment may reach — because the server runs the proxy in strict mode and will
# forward nothing until it is told what is allowed. See scripts/tenant-proxy/forward.js for why a
# *.auth0.com suffix allowlist is not safe once the host is reachable by more than one person.
#
# The Jira connection needs nothing: it registers its own OAuth client and holds a token per
# browser session, so there is no secret to inject and no state to persist.

FROM cgr.dev/chainguard/wolfi-base@sha256:03c6561658909fc4eadd0b2dc717375df40a22cc05455b8f82f1f1974e7e4427 AS build
RUN apk add --no-cache nodejs-22 npm
WORKDIR /app
# Copy manifests first so a dependency install is cached across source-only changes.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM cgr.dev/chainguard/wolfi-base@sha256:03c6561658909fc4eadd0b2dc717375df40a22cc05455b8f82f1f1974e7e4427
RUN apk add --no-cache nodejs-22
WORKDIR /app
ENV NODE_ENV=production

# The server serves dist/ and imports the two server-side pieces. Neither has a dependency of its
# own, so nothing from node_modules is needed at runtime — no npm in this stage.
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/tenant-proxy ./scripts/tenant-proxy
COPY --from=build /app/scripts/jira-mcp ./scripts/jira-mcp
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/package.json ./package.json

USER nonroot
ENV PORT=8080
# Declared with its default so a deploy preflight does not read it as required-but-unset. It is
# genuinely optional; server.js falls back to the same number.
ENV TENANT_RATE_LIMIT=60
EXPOSE 8080
CMD ["node", "server.js"]
