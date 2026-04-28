FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/teams-bot/package.json ./packages/teams-bot/
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY packages/teams-bot ./packages/teams-bot
RUN pnpm --filter @cip/shared build && pnpm --filter @cip/teams-bot build
RUN pnpm prune --prod
# Replace the workspace symlink with a real directory so the final image is self-contained
RUN cp -rL node_modules/@cip/shared /tmp/shared && \
    rm -rf node_modules/@cip/shared && \
    mv /tmp/shared node_modules/@cip/shared

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/teams-bot/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3978
CMD ["node", "dist/index.js"]
