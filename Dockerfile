# Single image: build the web bundle, then run the broker that serves it.
# The broker runs straight from TypeScript via tsx (matching `npm start`), so
# devDependencies are kept in the image on purpose — there is no server build step.
FROM node:24-slim

WORKDIR /app

# Copy the lockfile and every workspace manifest first so `npm ci` resolves the
# monorepo and this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm ci

COPY . .

# Vite build -> apps/web/dist, which the broker serves via OMXTERM_WEB_ROOT.
RUN npm run build

# Defaults baked for the container; secrets/origin come from compose env at runtime.
# NODE_ENV is set after install/build so npm ci still pulls devDeps (tsx, vite).
ENV NODE_ENV=production
ENV OMXTERM_WEB_ROOT=/app/apps/web/dist
ENV OMXTERM_SERVER_HOST=0.0.0.0
ENV OMXTERM_SERVER_PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "@omxterm/server"]
