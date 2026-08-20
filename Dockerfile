FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM dependencies AS operations-builder
WORKDIR /app
COPY . .
RUN mkdir -p /runtime-dist && ./node_modules/esbuild/bin/esbuild scripts/backup.ts scripts/restore.ts scripts/migrate.ts scripts/worker.ts scripts/pi-runner.ts --bundle --platform=node --format=esm --packages=external --sourcemap --outdir=/runtime-dist --out-extension:.js=.mjs

FROM node:22-alpine AS operations
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache postgresql-client && addgroup --system --gid 1001 nexus && adduser --system --uid 1001 --ingroup nexus nexus
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=operations-builder --chown=nexus:nexus /runtime-dist ./dist
COPY --from=operations-builder --chown=nexus:nexus /app/src/platform/database/migrations ./src/platform/database/migrations
COPY --from=operations-builder --chown=nexus:nexus /app/package.json ./package.json
USER nexus
ENTRYPOINT ["node"]

FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nexus && adduser --system --uid 1001 --ingroup nexus nexus
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=operations-builder --chown=nexus:nexus /runtime-dist/worker.mjs /runtime-dist/worker.mjs.map ./dist/
COPY --from=operations-builder --chown=nexus:nexus /app/package.json ./package.json
USER nexus
STOPSIGNAL SIGTERM
CMD ["node", "dist/worker.mjs"]

FROM worker AS pi-runner
COPY --from=operations-builder --chown=nexus:nexus /runtime-dist/pi-runner.mjs /runtime-dist/pi-runner.mjs.map ./dist/
CMD ["node", "dist/pi-runner.mjs"]

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nexus && adduser --system --uid 1001 --ingroup nexus nexus
COPY --from=builder --chown=nexus:nexus /app/.next/standalone ./
COPY --from=builder --chown=nexus:nexus /app/.next/static ./.next/static
COPY --from=builder --chown=nexus:nexus /app/public ./public
COPY --from=builder --chown=nexus:nexus /app/package.json ./package.json
USER nexus
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
