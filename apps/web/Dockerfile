# syntax=docker/dockerfile:1.7
FROM node:22.17.0-alpine3.22 AS manifests
WORKDIR /workspace
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ARG NEXT_PUBLIC_TERMS_VERSION=terms-2026-06
ARG NEXT_PUBLIC_PRIVACY_VERSION=privacy-2026-06
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_TERMS_VERSION=$NEXT_PUBLIC_TERMS_VERSION \
    NEXT_PUBLIC_PRIVACY_VERSION=$NEXT_PUBLIC_PRIVACY_VERSION \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm install --global npm@11.12.1

FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps ./apps
RUN npm run build --workspace @clipbr/web

FROM node:22.17.0-alpine3.22 AS runtime
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && addgroup -S clipbr -g 10001 \
    && adduser -S clipbr -u 10001 -G clipbr
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=clipbr:clipbr /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=clipbr:clipbr /workspace/apps/web/.next/static ./apps/web/.next/static
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
