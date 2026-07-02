# syntax=docker/dockerfile:1.7
FROM node:22.17.0-alpine3.22 AS manifests
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm install --global npm@11.12.1

FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm npm ci

COPY apps ./apps

RUN npm run db:generate --workspace @clipbr/api \
    && npm run build --workspace @clipbr/api

FROM manifests AS production-dependencies
RUN --mount=type=cache,target=/root/.npm test -s /workspace/package-lock.json \
    && npm ci --omit=dev \
    && node -e "require.resolve('ioredis', { paths: ['/workspace/apps/api'] }); require.resolve('bullmq', { paths: ['/workspace/apps/api'] }); require('@prisma/client')"

FROM node:22.17.0-alpine3.22 AS runtime-base
RUN apk upgrade --no-cache \
    && apk add --no-cache dumb-init \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && addgroup -S clipbr -g 10001 \
    && adduser -S clipbr -u 10001 -G clipbr
WORKDIR /workspace

ENV NODE_ENV=production \
    PORT=3001

FROM runtime-base AS migration
COPY --from=build --chown=clipbr:clipbr /workspace/package.json /workspace/package-lock.json ./
COPY --from=build --chown=clipbr:clipbr /workspace/node_modules ./node_modules
COPY --from=build --chown=clipbr:clipbr /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=clipbr:clipbr /workspace/apps/api/prisma ./apps/api/prisma
USER 10001:10001
ENTRYPOINT ["/usr/bin/dumb-init", "--", "./node_modules/.bin/prisma"]
CMD ["migrate", "deploy", "--schema=apps/api/prisma/schema.prisma"]

FROM runtime-base AS runtime
COPY --from=build --chown=clipbr:clipbr /workspace/package.json /workspace/package-lock.json ./
COPY --from=production-dependencies --chown=clipbr:clipbr /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=clipbr:clipbr /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=clipbr:clipbr /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=clipbr:clipbr /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=clipbr:clipbr /workspace/apps/api/dist ./apps/api/dist
COPY --from=build --chown=clipbr:clipbr /workspace/apps/api/prisma ./apps/api/prisma
USER 10001:10001
EXPOSE 3001
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
