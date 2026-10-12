#!/usr/bin/env bash
# Build Pi's packages from a commit of earendil-works/pi, pack them into
# .pi-main/, which package.json installs from until the next Pi release, and
# install them.
#
#   scripts/pi-main.sh             clone the commit in .pi-main-rev and build it
#   scripts/pi-main.sh <checkout>  build an existing checkout instead
#
# bun.lock records a local tarball's dependencies once and never reads them
# again, so the script rewrites the entries of Pi's packages from the new
# tarballs before installing. Builds differ in bytes, so the lockfile keeps
# no hashes of Pi's packages.

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
lock="$root/bun.lock"
node - "$lock" "$out" "${packages[@]}" <<'JS'
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const [lock, out, ...packages] = process.argv.slice(2);
// bun.lock's inline style: { "a": "1", "b": "2" }, ["a"], {}.
const format = (value) =>
  Array.isArray(value)
    ? `[${value.map(format).join(", ")}]`
    : typeof value === "object"
      ? Object.keys(value).length === 0
        ? "{}"
        : `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${format(v)}`).join(", ")} }`
      : JSON.stringify(value);
let text = readFileSync(lock, "utf8");
for (const name of packages) {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", `${out}/${name}.tgz`, "package/package.json"], { encoding: "utf8" }),
  );
  const meta = {};
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"])
    if (manifest[key] && Object.keys(manifest[key]).length > 0) meta[key] = manifest[key];
  const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, value]) => value.optional)
    .map(([peer]) => peer);
  if (optionalPeers.length > 0) meta.optionalPeers = optionalPeers;
  if (manifest.bin) meta.bin = manifest.bin;
  const id = `${manifest.name}@./.pi-main/${name}.tgz`;
  const line = new RegExp(`^(    ${JSON.stringify(manifest.name)}: \\[${JSON.stringify(id).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}, ).*\\],$`, "m");
  text = text.replace(line, (_, head) => `${head}${format(meta)}],`);
}
writeFileSync(lock, text);
JS
(cd "$root" && bun install --silent)
# Portable in-place edit for GNU and BSD sed.
sed -E -i.bak '/\.pi-main\/[a-z-]+\.tgz", \{/s/, "sha512-[^"]+"\]/]/' "$lock"
rm "$lock.bak"
echo "Packed ${#packages[@]} packages from $(git -C "$src" rev-parse --short HEAD) into $out"
