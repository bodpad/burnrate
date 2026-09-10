# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public

# Runs unprivileged. The node image ships a `node` user; using it means the agent does not need a
# root container to serve a chat page.
USER node

# The platform reads this, and insygna.yaml declares the same port — declared beats detected, and
# the two disagreeing is a routing failure nobody can see from either file alone.
EXPOSE 8080

# The one line that makes this work inside a traced pod.
#
# The platform's instrumentation bakes the mitmproxy sidecar's CA into the image's system trust
# store and injects SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt — the convention every
# OpenSSL-based client reads (curl, Go, Ruby). Node reads neither the system store nor that
# variable: it carries its own bundled roots and only extends them from NODE_EXTRA_CA_CERTS, which
# has to be set before the process starts, so it cannot be done from inside the app.
#
# Mapping it here rather than switching language keeps the SDK untouched. Unset (a plain local run),
# nothing changes and Node's own roots apply.
CMD ["sh", "-c", "if [ -n \"$SSL_CERT_FILE\" ]; then export NODE_EXTRA_CA_CERTS=\"$SSL_CERT_FILE\"; fi; exec node dist/server.js"]
