#!/usr/bin/env bash
# Build immich-server:<version>-same-person from this branch.
#
# Usage (inside WSL / on the server, from anywhere): docker/same-person/build.sh v3.3.5
#
# Updating to a new Immich release:
#   git fetch --depth 1 origin tag v3.4.0
#   git rebase --onto v3.4.0 <current version tag> same-person-suggestions
#   docker/same-person/build.sh v3.4.0
set -euo pipefail

version=${1:?usage: $0 <immich version tag, e.g. v3.3.5>}
cd "$(dirname "$0")/../.."

builder=$(grep -m1 -oE 'ghcr.io/immich-app/base-server-dev:[^ ]+' server/Dockerfile)
docker build \
  -f docker/same-person/Dockerfile \
  --build-arg IMMICH_VERSION="$version" \
  --build-arg BUILDER_IMAGE="$builder" \
  -t "immich-server:${version}-same-person" \
  .
echo "built immich-server:${version}-same-person"
