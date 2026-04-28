FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/hr-service/package.json ./packages/hr-service/
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY packages/hr-service ./packages/hr-service
RUN pnpm --filter @cip/shared build && pnpm --filter @cip/hr-service build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/hr-service/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/package.json ./node_modules/@cip/shared/package.json
COPY --from=builder /app/packages/shared/dist ./node_modules/@cip/shared/dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
