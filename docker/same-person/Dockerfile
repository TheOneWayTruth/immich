# Official Immich server image with this branch's server code and web app swapped in.
# Dependencies are untouched, so only server/dist and the web build need rebuilding.
# Build from the repo root: docker/same-person/build.sh
ARG IMMICH_VERSION
# the build image upstream's server/Dockerfile uses for this version (build.sh reads it from there)
ARG BUILDER_IMAGE

FROM ${BUILDER_IMAGE} AS builder
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  CI=1 \
  COREPACK_HOME=/tmp \
  PNPM_HOME=/buildcache/pnpm-store \
  PATH="/buildcache/pnpm-store:$PATH"

RUN npm install --global corepack@latest && \
  corepack enable pnpm && \
  pnpm config set store-dir "$PNPM_HOME"

WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./

FROM builder AS sdk

COPY ./packages/sdk/package.json ./packages/sdk/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/sdk install --frozen-lockfile

COPY ./packages/sdk ./packages/sdk/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/sdk build

FROM sdk AS plugin-sdk

COPY ./packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/plugin-sdk install --frozen-lockfile

COPY ./packages/plugin-sdk ./packages/plugin-sdk/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter @immich/plugin-sdk build

FROM plugin-sdk AS server

COPY ./server/package.json ./server/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich install --frozen-lockfile

COPY ./server ./server/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich build

FROM sdk AS web

COPY ./web/package.json ./web/package.json
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich-web install --frozen-lockfile

COPY ./i18n ./i18n/
COPY ./web ./web/
RUN --mount=type=cache,id=pnpm,target=/buildcache/pnpm-store pnpm --filter immich-web build

FROM ghcr.io/immich-app/immich-server:${IMMICH_VERSION}

RUN rm -rf /usr/src/app/server/dist /build/www
COPY --from=server /usr/src/app/server/dist /usr/src/app/server/dist
COPY --from=web /usr/src/app/web/build /build/www
