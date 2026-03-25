# Stage 1: Build stage
FROM cgr.dev/chainguard/node:latest-dev@sha256:7b7b121a191d77b40f52a8adf5bd9af2329dbef08e3aae3eb6fe8eb912d1660e AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Stage 2: Production dependencies
FROM cgr.dev/chainguard/node:latest-dev@sha256:7b7b121a191d77b40f52a8adf5bd9af2329dbef08e3aae3eb6fe8eb912d1660e AS production-deps

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod --ignore-scripts && \
    pnpm store prune

# Stage 3: Runtime
FROM cgr.dev/chainguard/node:latest@sha256:b73c955ff6449b039c260fdd819b290c127dc8b94c00799535744452270f19f5 AS production

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./package.json

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:9000/ready', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["dist/main.js"]