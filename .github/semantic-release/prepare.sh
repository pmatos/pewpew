#!/usr/bin/env bash
# Invoked by semantic-release (@semantic-release/exec prepareCmd) with the next
# version. Syncs package.json, builds the Linux AppImage + deb via
# electron-builder, and stages artifacts + checksums for @semantic-release/github.
set -euo pipefail
VERSION="${1:?usage: prepare.sh <version>}"

npm version "${VERSION}" --no-git-tag-version --allow-same-version

npm run dist:linux

rm -rf release-upload
mkdir -p release-upload
shopt -s nullglob
for f in release/*.AppImage release/*.deb release/latest-linux.yml; do
  cp "$f" release-upload/
done
shopt -u nullglob
( cd release-upload && sha256sum -- * > SHA256SUMS.txt )
ls -la release-upload
