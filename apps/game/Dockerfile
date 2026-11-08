# Build context: repository root.  docker build -f apps/game/Dockerfile .
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/game/package.json apps/game/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @dead-air/game...
COPY packages/shared packages/shared
COPY apps/game apps/game
COPY stations stations
# The server reads landmarks and spawn points from the city build.
COPY apps/web/public/city apps/web/public/city
ENV NODE_ENV=production PORT=2567 DB_PATH=/data/dead-air.db
VOLUME /data
EXPOSE 2567
WORKDIR /app/apps/game
CMD ["npx", "tsx", "src/index.ts"]
