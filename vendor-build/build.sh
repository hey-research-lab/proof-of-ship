#!/bin/sh
# Rebuilds app/vendor/viem.js and app/vendor/walletconnect.js from the pinned package locks in this folder, then
# checks them against app/vendor/SHA256SUMS. Run from the repository root: sh vendor-build/build.sh
# Install scripts are never run (--ignore-scripts); npm ci installs exactly what each package-lock.json names.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/app/vendor"

build() {
  name=$1
  dir="$root/vendor-build/$name"
  (cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
  "$dir/node_modules/.bin/esbuild" "$dir/entry.js" --bundle --format=esm --minify --log-level=warning --outfile="$dir/out.js"
}

build viem
{
  printf '%s\n' "/*! viem 2.21.55 (MIT, https://github.com/wevm/viem), bundled once with esbuild 0.25.12 from the npm package: only the"
  printf '%s\n' "    functions app.js imports. Served from this site, so the page loads no third-party script at runtime. */"
  cat "$root/vendor-build/viem/out.js"
} >"$out/viem.js"

build walletconnect
cp "$root/vendor-build/walletconnect/out.js" "$out/walletconnect.js"

rm -f "$root/vendor-build/viem/out.js" "$root/vendor-build/walletconnect/out.js"
(cd "$out" && shasum -a 256 -c SHA256SUMS)
