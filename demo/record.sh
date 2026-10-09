#!/usr/bin/env bash
# Regenerates the README's demo, demo/agents.gif, from demo/demo.tape.
#
# Needs nix, which provides vhs and gifsicle, plus pi on the PATH.
set -euo pipefail

cd "$(dirname "$0")/.."
nix="nix --extra-experimental-features nix-command --extra-experimental-features flakes"
work=$(mktemp -d)
# Resolve macOS's /tmp symlink so pi can shorten the throwaway HOME to `~`.
work=$(cd "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT

export AGENTS="$PWD"
export DEMO="$work/home"
mkdir -p "$DEMO/.pi/agent"
cp -R demo/project "$DEMO/project"
printf '%s\n' '{ "theme": "dark", "quietStartup": "header" }' \
  > "$DEMO/.pi/agent/settings.json"

$nix run nixpkgs#vhs -- demo/demo.tape -o "$work/recording.gif"
$nix run nixpkgs#gifsicle -- -O3 --lossy=80 --colors 128 "$work/recording.gif" -o demo/agents.gif

ls -lh demo/agents.gif
