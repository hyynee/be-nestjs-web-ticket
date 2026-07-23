ARG NODE_IMAGE=node:22-bookworm-slim

# Stage 1: Build stage
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Stage 2: Production dependencies
FROM ${NODE_IMAGE} AS production-deps

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    pnpm store prune

# Stage 3: Runtime
FROM ${NODE_IMAGE} AS production

WORKDIR /app

ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV

COPY --from=builder /app/dist ./dist
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./package.json

# The runtime never invokes npm/npx/corepack (CMD below calls `node` directly),
# so the npm CLI bundled in the base image is dead weight in production — and
# its own vendored `tar` dependency periodically trails a CVE fix (e.g.
# CVE-2026-59873) that this project has no way to patch via package.json/
# pnpm-lock.yaml, since it isn't part of this app's dependency graph at all.
# Removing it shrinks the image and eliminates that finding at the source
# instead of suppressing it in the Trivy scan config.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:9000/ready', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT []
CMD ["node", "dist/main"]
