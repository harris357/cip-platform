FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth/package.json ./packages/auth/
COPY packages/document-service/package.json ./packages/document-service/
RUN pnpm install --frozen-lockfile --shamefully-hoist
COPY packages/shared ./packages/shared
COPY packages/auth ./packages/auth
COPY packages/document-service ./packages/document-service
# Slice 67: @cip/auth must build before document-service depends on it.
RUN pnpm --filter @cip/shared build \
 && pnpm --filter @cip/auth build \
 && pnpm --filter @cip/document-service build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/packages/document-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./node_modules/@cip/shared/package.json
COPY --from=builder /app/packages/shared/dist ./node_modules/@cip/shared/dist
COPY --from=builder /app/packages/auth/package.json ./node_modules/@cip/auth/package.json
COPY --from=builder /app/packages/auth/dist ./node_modules/@cip/auth/dist
COPY --from=builder /app/packages/document-service/src/db/migrations ./dist/db/migrations
EXPOSE 3000
CMD ["node", "dist/index.js"]
