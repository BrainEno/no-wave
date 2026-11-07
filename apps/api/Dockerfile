FROM node:24-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# 80 is what a host router in front of the container expects to reach; PORT overrides it.
ENV PORT=80

WORKDIR /app

RUN corepack enable

# Keep the API image reproducible by using the repository's single pnpm lockfile.
# Every workspace manifest is copied because pnpm validates all workspace importers
# against the lockfile, even when only the API package is selected for installation.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web-rr/package.json ./apps/web-rr/package.json
COPY packages/web-http/package.json ./packages/web-http/package.json
COPY packages/web-ui/package.json ./packages/web-ui/package.json

RUN pnpm install --frozen-lockfile --prod --filter @bot-thk/api

COPY apps/api/src ./apps/api/src

EXPOSE 80
CMD ["node", "apps/api/src/server.ts"]
