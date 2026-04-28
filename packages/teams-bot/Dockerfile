FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/teams-bot/package.json ./packages/teams-bot/
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY packages/teams-bot ./packages/teams-bot
RUN pnpm --filter @cip/shared build && pnpm --filter @cip/teams-bot build
RUN pnpm --filter @cip/teams-bot deploy --prod /deploy

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /deploy ./
EXPOSE 3978
CMD ["node", "dist/index.js"]
