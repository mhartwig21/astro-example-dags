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
COPY --from=build /app/dist ./dist
COPY src ./src
COPY tsconfig.json ./

ENV PORT=8080
ENV STATIC_DIR=dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "src/server/gameServer.ts"]
