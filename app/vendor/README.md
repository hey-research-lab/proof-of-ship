# app/vendor

The two scripts the page loads besides its own, served from this site so the page runs no third-party script at
runtime (`script-src 'self'`). Each is rebuilt from a pinned lockfile in [`vendor-build/`](../../vendor-build) and
checked against [`SHA256SUMS`](SHA256SUMS).

| File | Package | Entry | Built with |
|---|---|---|---|
| `viem.js` | `viem` 2.21.55 | `vendor-build/viem/entry.js` — only the functions `app.js` imports | esbuild 0.25.12 |
| `walletconnect.js` | `@walletconnect/ethereum-provider` 2.26.0 (with `@reown/appkit` 1.8.19 and its tree as locked) | `vendor-build/walletconnect/entry.js` — `EthereumProvider` | esbuild 0.25.12 |

## Rebuild and check

From the repository root, with Node 22 and npm 11:

```sh
sh vendor-build/build.sh
```

For each of `vendor-build/viem` and `vendor-build/walletconnect` it runs

```sh
npm ci --ignore-scripts --no-audit --no-fund
node_modules/.bin/esbuild entry.js --bundle --format=esm --minify --outfile=out.js
```

then writes `viem.js` (the two-line licence header above the bundle) and `walletconnect.js` (the bundle as is) here,
and runs `shasum -a 256 -c SHA256SUMS`. A rebuild that does not match fails.

- `npm ci` installs exactly what each `package-lock.json` names and never runs a package's install scripts.
- The WalletConnect lockfile was resolved with `npm install --before=2026-10-10T00:00:00Z`, so no package in its tree
  is newer than that date. To move a version, change `package.json`, resolve again with a `--before` date at least two
  weeks back, rebuild, test the page, and commit the lockfile, the bundle and the new `SHA256SUMS` together.

`walletconnect.js` is loaded only when a reader chooses WalletConnect. The page's Content-Security-Policy lets it reach
only the hosts it uses: `wss://relay.walletconnect.org`, `https://verify.walletconnect.org` and
`https://api.web3modal.org`.
