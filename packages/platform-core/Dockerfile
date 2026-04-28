FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/platform-core/package.json ./packages/platform-core/
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY packages/platform-core ./packages/platform-core
RUN pnpm --filter @cip/shared build && pnpm --filter @cip/platform-core build
RUN pnpm --filter @cip/platform-core deploy --prod /deploy

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /deploy ./
EXPOSE 3001
CMD ["node", "dist/index.js"]
