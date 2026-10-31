# The React Router Web application as a portable container image.
#
# Two stages: the first builds the application, the second runs it. The runtime
# stage installs production dependencies only, so this file is also a test of the
# dependency graph — anything `server.ts` imports at runtime has to be a real
# dependency rather than a devDependency that merely happens to be installed.
#
# There is nothing platform-specific here: `node server.ts` is the same command
# ADR 0012 asks for, the base image is upstream Node, and every input is an
# environment variable. Any host that can run a container can run this.
#
# The base image is `node:24-slim` (glibc) rather than `-alpine` (musl) on
# purpose: the lockfile records esbuild's glibc build, and pnpm selects optional
# platform packages by the running libc, so a musl image installs esbuild without
# a binary and `react-router build` dies a second into the build.

# ---- Build -------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app
RUN corepack enable

# Every workspace manifest has to be copied: pnpm validates all importers
# against the single lockfile even when only one package is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web-rr/package.json ./apps/web-rr/package.json
COPY packages/web-http/package.json ./packages/web-http/package.json

# The build needs devDependencies (vite, @react-router/dev), so NODE_ENV is set
# only after this step: pnpm reads NODE_ENV=production as `--prod`.
RUN pnpm install --frozen-lockfile --filter @bot-thk/web-rr...

COPY packages/web-http ./packages/web-http
COPY apps/web-rr ./apps/web-rr

ENV NODE_ENV=production
RUN pnpm --filter @bot-thk/web-rr build

# ---- Runtime -----------------------------------------------------------------
FROM node:24-slim AS runtime

# Documented inputs only. PORT and HOST are the server's own knobs with defaults
# (3100, 0.0.0.0); API_BASE_URL is how this tier finds the API. No Vercel or
# platform variable is read, and none is needed.
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3100

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/web-rr/package.json ./apps/web-rr/package.json
COPY packages/web-http/package.json ./packages/web-http/package.json

RUN pnpm install --frozen-lockfile --prod --filter @bot-thk/web-rr...

# `@bot-thk/web-http` is consumed as TypeScript source — Node 24 strips the
# types — so the package body has to travel with the image.
COPY packages/web-http/src ./packages/web-http/src
COPY apps/web-rr/server.ts ./apps/web-rr/server.ts
COPY --from=build /app/apps/web-rr/build ./apps/web-rr/build

# `server.ts` resolves `RR_BUILD_DIR` / `RR_SERVER_BUILD_DIR` relative to the
# working directory — that is how `pnpm --filter @bot-thk/web-rr start` runs it
# — so the container starts from the application directory too.
WORKDIR /app/apps/web-rr

# The server writes nothing to disk, so it does not need to run as root.
USER node

EXPOSE 3100

# The only entry a deployment needs to know. `PORT` and `HOST` come from the
# environment; the client build comes from the build stage.
CMD ["node", "server.ts"]
