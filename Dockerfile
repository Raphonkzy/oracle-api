# Oracle backend image: the REST API plus the database code it uses.
# Build from the repository root:  docker build -t oracle-api .
# (docker-compose.prod.yml does this for you.) The submodule must be checked out first: git submodule update --init
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY db/package.json db/
COPY vendor/oracle/shared/core/package.json vendor/oracle/shared/core/
# Keep only the server workspaces and no dev tools, so npm installs the server's own dependencies (at the versions
# pinned in package-lock.json) and nothing else.
# `--omit=peer`: the server half of @better-auth/expo lists the whole Expo SDK as optional peers, and it needs none of it.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.devDependencies;fs.writeFileSync('package.json',JSON.stringify(p,null,2))" \
 && npm install --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund \
 && npm prune --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY api api
# The lockfile keeps some server packages (@better-auth/expo, better-auth) in api/node_modules, not at the root.
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY db db
COPY vendor/oracle/shared/core vendor/oracle/shared/core
USER node
WORKDIR /app/api
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/api/health >/dev/null || exit 1
# Applies database migrations and refreshes the provider catalog on start (RUN_MIGRATIONS=true), then serves.
CMD ["node", "--import", "tsx", "src/server.ts"]
