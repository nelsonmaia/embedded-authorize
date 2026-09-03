# The deployed console: the built app plus the tenant proxy it cannot work without.
#
# Nothing here needs a secret. The one thing to set is PLAYGROUND_ALLOWED_HOSTS — the exact tenant
# domains this deployment may reach — because the server runs the proxy in strict mode and will
# forward nothing until it is told what is allowed. See scripts/tenant-proxy/forward.js for why a
# *.auth0.com suffix allowlist is not safe once the host is reachable by more than one person.
#
# The Jira connection needs nothing: it registers its own OAuth client and holds a token per
# browser session, so there is no secret to inject and no state to persist.

FROM node:22-alpine AS build
WORKDIR /app
# Copy manifests first so a dependency install is cached across source-only changes.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The server serves dist/ and imports the two server-side pieces. Neither has a dependency of its
# own, so nothing from node_modules is needed at runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/tenant-proxy ./scripts/tenant-proxy
COPY --from=build /app/scripts/jira-mcp ./scripts/jira-mcp
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/package.json ./package.json

USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
