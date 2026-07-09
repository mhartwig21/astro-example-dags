# Dungeon Crawler Claude — one container serves the built client AND the
# authoritative game server on a single port. Deliberately platform-agnostic
# (no Fly/GCP-specific APIs): the same image runs on Fly.io today and moves to
# GCP (Cloud Run w/ min=max=1, or a Compute Engine VM) by pointing at the image.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build   # typecheck + vite build -> dist/ (includes CC0 assets)

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx is a production dependency (it runs the server), so npm ci installs it here.
RUN npm ci --omit=dev && npm cache clean --force
# Litestream: continuous SQLite replication to Tigris (PERSISTENCE.md).
# Pinned to the stable 0.3 line on purpose — backups should be boring.
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb
COPY litestream.yml /etc/litestream.yml
COPY --from=build /app/dist ./dist
COPY src ./src
COPY tsconfig.json ./

ENV PORT=8080
ENV STATIC_DIR=dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Signal flow matters here (the server checkpoints on SIGINT): every branch
# `exec`s so the final process is PID-1-adjacent and receives Fly's stop
# signal — litestream forwards signals to its -exec child. With no Tigris
# credentials in the environment (local dev, plain `docker run`), litestream
# is skipped and node runs directly. On a fresh/replaced volume, `restore
# -if-db-not-exists` pulls the latest replica back down before serving.
CMD ["sh", "-c", "if [ -n \"$BUCKET_NAME\" ]; then litestream restore -if-db-not-exists -if-replica-exists /data/dcc.sqlite && exec litestream replicate -exec 'node --import tsx src/server/gameServer.ts'; else exec node --import tsx src/server/gameServer.ts; fi"]
