FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/hr-service/package.json ./packages/hr-service/
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY packages/hr-service ./packages/hr-service
RUN pnpm --filter @cip/shared build && pnpm --filter @cip/hr-service build
RUN pnpm --filter @cip/hr-service deploy --prod /deploy

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /deploy ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
