FROM node:24-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# Unprivileged by default. Hosts should route to this port (or override PORT).
ENV PORT=4000
# This directory is owned by node and is safe for an initialized named volume.
ENV DATABASE_PATH=/var/lib/no-wave/no-wave.sqlite

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
COPY packages/glob-match/package.json ./packages/glob-match/package.json
COPY patches ./patches

RUN pnpm install --frozen-lockfile --prod --filter @no-wave/api

COPY apps/api/src ./apps/api/src

# SQLite and its WAL/SHM files need a writable parent; application code remains
# owned by root. Docker seeds a newly created named volume from this directory.
RUN mkdir -p /var/lib/no-wave && chown node:node /var/lib/no-wave
USER node

# Probe the actual configured port, independent of curl/wget or external hosts.
# The role selects its own /ready listener; the worker is not an API sidecar.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "const role=process.env.SERVICE_ROLE||'api';if(!['api','notification-worker'].includes(role))process.exit(1);const port=Number(role==='notification-worker'?(process.env.OUTBOX_HEALTH_PORT||'4001'):(process.env.PORT||'4000'));if(!Number.isInteger(port)||port<1||port>65535)process.exit(1);fetch('http://127.0.0.1:'+port+'/ready',{signal:AbortSignal.timeout(2000),redirect:'manual'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 4000 4001
CMD ["node", "apps/api/src/service.ts"]
