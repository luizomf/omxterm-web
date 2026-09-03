# Single image: build the web bundle, then run the broker that serves it.
# The broker runs straight from TypeScript via tsx (matching `npm start`), so
# devDependencies are kept in the image on purpose — there is no server build step.
FROM node:24.19.0-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

WORKDIR /app

# Copy the lockfile and every workspace manifest first so the repository
# bootstrap resolves the monorepo and this layer caches until a dependency
# actually changes.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
# The repository bootstrap disables every lifecycle script, checks the complete
# locked lifecycle surface, explicitly rebuilds only audited packages, and
# applies the ssh2 adaptation. Copy both repository-owned implementations into
# the cached dependency layer and verify again before application sources enter.
COPY scripts/install-dependencies.mjs scripts/install-dependencies.mjs
COPY scripts/ssh2-auth-material-adaptation.mjs scripts/ssh2-auth-material-adaptation.mjs
RUN npm run bootstrap && npm run verify:ssh2-adaptation

COPY . .

# Vite build -> apps/web/dist, which the broker serves via OMXTERM_WEB_ROOT.
RUN npm run build

# The runtime starts Node directly and needs neither npm nor Corepack. Removing
# package-manager tooling drops unrelated archive/network parsers from the
# public image while leaving the locked application dependencies untouched.
RUN rm -rf \
  /usr/local/bin/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/lib/node_modules/corepack \
  /usr/local/lib/node_modules/npm

# Defaults baked for the container; secrets/origin come from compose env at runtime.
# NODE_ENV is set after install/build so bootstrap includes devDeps (tsx, vite).
ENV NODE_ENV=production
ENV OMXTERM_WEB_ROOT=/app/apps/web/dist
ENV OMXTERM_SERVER_HOST=0.0.0.0
ENV OMXTERM_SERVER_PORT=3000

EXPOSE 3000

# The broker opens outbound SSH connections and parses untrusted terminal data;
# it does not need root privileges at runtime. The base image provides this user.
USER node

# Keep Node as PID 1 so Docker stop signals reach the broker directly instead of
# relying on npm's child-process forwarding during session teardown.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
