FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/teams-bot/package.json ./packages/teams-bot/
RUN pnpm install --frozen-lockfile --shamefully-hoist
COPY packages/shared ./packages/shared
COPY packages/teams-bot ./packages/teams-bot
RUN pnpm --filter @cip/shared build && pnpm --filter @cip/teams-bot build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/packages/teams-bot/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./node_modules/@cip/shared/package.json
COPY --from=builder /app/packages/shared/dist ./node_modules/@cip/shared/dist
EXPOSE 3978
CMD ["node", "dist/index.js"]
