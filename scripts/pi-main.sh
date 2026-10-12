#!/usr/bin/env bash
# Build Pi's packages from a commit of earendil-works/pi and pack them into
# .pi-main/, which package.json installs from until the next Pi release.
#
#   scripts/pi-main.sh             clone the commit in .pi-main-rev and build it
#   scripts/pi-main.sh <checkout>  build an existing checkout instead
#
# Run `bun install` afterwards. Builds differ in bytes, so bun.lock must
# not pin the tarballs' hashes; this script drops any that `bun install`
# recorded.

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/.pi-main"
packages=(chord tui telemetry codemode mcp ai durable agent coding-agent)

if [ $# -gt 0 ]; then
  src=$(cd "$1" && pwd)
else
  rev=$(tr -d '[:space:]' <"$root/.pi-main-rev")
  src="$out/src"
  if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null)" != "$rev" ]; then
    rm -rf "$src"
    git init -q "$src"
    git -C "$src" fetch -q --depth 1 https://github.com/earendil-works/pi.git "$rev"
    git -C "$src" checkout -q FETCH_HEAD
  fi
  (cd "$src" && npm ci --ignore-scripts --no-audit --no-fund)
fi

# pi-ai's build fetches the model catalog.
for package in "${packages[@]}"; do
  (cd "$src/packages/$package" && npm run build >/dev/null)
done

mkdir -p "$out"
for package in "${packages[@]}"; do
  tarball=$(cd "$src/packages/$package" &&
    npm pack --ignore-scripts --silent --pack-destination "$out")
  mv "$out/$tarball" "$out/$package.tgz"
done
# Portable in-place edit for GNU and BSD sed.
sed -E -i.bak '/\.pi-main\/[a-z-]+\.tgz", \{/s/, "sha512-[^"]+"\]/]/' "$root/bun.lock"
rm "$root/bun.lock.bak"
echo "Packed ${#packages[@]} packages from $(git -C "$src" rev-parse --short HEAD) into $out"
