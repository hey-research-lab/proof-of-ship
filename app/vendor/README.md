# app/vendor

The three scripts and two fonts the page loads besides its own, served from this site so the page runs no third-party script at
runtime (`script-src 'self'`). Each is rebuilt from a pinned lockfile in [`vendor-build/`](../../vendor-build) and
checked against [`SHA256SUMS`](SHA256SUMS).

| File | Package | Entry | Built with |
|---|---|---|---|
| `viem.js` | `viem` 2.21.55 | `vendor-build/viem/entry.js` — only the functions `app.js` imports | esbuild 0.25.12 |
| `walletconnect.js` | `@walletconnect/ethereum-provider` 2.26.0 (with `@reown/appkit` 1.8.19 and its tree as locked) | `vendor-build/walletconnect/entry.js` — `EthereumProvider` | esbuild 0.25.12 |
| `near.js` | `@near-wallet-selector/core`, `@near-wallet-selector/meteor-wallet` and `@near-wallet-selector/my-near-wallet` 10.1.4 (with `buffer` 6.0.3 and `util` 0.12.5 for the browser) | `vendor-build/near/entry.js`: `setupWalletSelector`, `actionCreators`, `setupMeteorWallet`, `setupMyNearWallet` | esbuild 0.25.12, with `--define:global=globalThis` and `vendor-build/near/process-shim.js` injected |
| `fonts/Geist-Variable.woff2`, `fonts/GeistMono-Variable.woff2`, `fonts/OFL.txt` | `geist` 1.7.2 (Vercel, SIL Open Font License 1.1) | copied as is from the npm package's `dist/fonts/` and `LICENSE.txt` | — |

## Rebuild and check

From the repository root, with Node 22 and npm 11:

```sh
sh vendor-build/build.sh
```

For each of `vendor-build/viem`, `vendor-build/walletconnect` and `vendor-build/near` it runs

```sh
npm ci --ignore-scripts --no-audit --no-fund
node_modules/.bin/esbuild entry.js --bundle --format=esm --minify --outfile=out.js
```

then writes `viem.js` (the two-line licence header above the bundle), `walletconnect.js` and `near.js` (each bundle as is) here,
and runs `shasum -a 256 -c SHA256SUMS`, which also checks the fonts. A rebuild that does not match fails.

The fonts are not built: they are the files of the `geist` 1.7.2 npm package (`npm pack geist@1.7.2`, integrity
`sha512-Gu5lDFa3pLRyoBlBPf0QIFHVdWAnpco7fS1bJm41jyLPFoguBgiubseUN2oLXMgqZ7uxAxDoXcHMhCY/fOTTgg==`), so the page loads no
third-party stylesheet (`style-src 'self' 'unsafe-inline'`, `font-src 'self'`; WalletConnect's modal also loads its own
fonts from `https://fonts.reown.com`).

- `npm ci` installs exactly what each `package-lock.json` names and never runs a package's install scripts.
- The NEAR lockfile was resolved with `npm install --before=2026-10-20T00:00:00Z`.
- The WalletConnect lockfile was resolved with `npm install --before=2026-10-10T00:00:00Z`, so no package in its tree
  is newer than that date. To move a version, change `package.json`, resolve again with a `--before` date at least two
  weeks back, rebuild, test the page, and commit the lockfile, the bundle and the new `SHA256SUMS` together.

`walletconnect.js` is loaded only when a reader chooses WalletConnect. The page's Content-Security-Policy lets it reach
only the hosts it uses: `wss://relay.walletconnect.org`, `https://verify.walletconnect.org` and
`https://api.web3modal.org`.

`near.js` is loaded only on the NEAR view, when a reader opens the wallet picker or comes back with a NEAR wallet
connected. Reading NEAR bounties needs none of it: the page reads the escrow over public NEAR RPC with `fetch`. The
Content-Security-Policy lets it reach `https://free.rpc.fastnear.com`, `https://rpc.mainnet.near.org`,
`https://mw.rpc.fastnear.com` and `https://api.fastnear.com`; Meteor and MyNearWallet open their own windows
(`wallet.meteorwallet.app`, `app.mynearwallet.com`) and answer with `postMessage`, or Meteor's extension answers in
the page.
