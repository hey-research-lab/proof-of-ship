# Proof of Ship

Put $WIF behind a team building on Robinhood Chain. It reaches them only when
[Hey Research Lab](https://heyresearch.xyz) counts real ships for that team — releases, deployed contracts, code that
changed — each with its public source. No ships by the deadline, and every backer takes their $WIF back.

[![CI](https://github.com/hey-research-lab/proof-of-ship/actions/workflows/ci.yml/badge.svg)](https://github.com/hey-research-lab/proof-of-ship/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Robinhood Chain 4663](https://img.shields.io/badge/Robinhood%20Chain-4663-informational.svg)](#deployment)

Built for the [World is Flat hackathon](https://worldisflat.fun/build). **Demo video:** [hey-research-lab.github.io/proof-of-ship/demo.html](https://hey-research-lab.github.io/proof-of-ship/demo.html)

## Why

Holders want the token they hold to be used. Builders need runway to build things that use it. The usual answer is a
grant someone decides on, or a promise nobody checks. Proof of Ship replaces both with evidence: backers fund a bounty
in $WIF, the builder ships, and the money moves only when an independent reader of public sources says the shipping
happened.

## How it works

1. **Back.** Anyone opens a bounty for a project that has a page on HEY (`heyresearch.xyz/project/<slug>`): the
   builder's payout address, how many ships, a deadline, and a burn share of 0–10%. Anyone can add $WIF to it.
2. **Ship.** The builder ships. HEY reads its repositories, releases, contracts and feeds, and counts ships by the rule
   it uses on every page: corroborated building evidence; a repository's releases of one day count once; a deploy
   script's contracts count once; documentation-only weeks, dependency bumps, CI-only commits and automation never
   count. For a bounty HEY also counts only ships it first recorded inside the bounty's window (work pushed after the
   deadline and dated back never counts), and at most one ship of each kind — a release, a contract deployment or
   upgrade, a code week, any other entry — per day HEY first recorded it.
   HEY signs only for a payout address its evidence ties to the project: the signer of a verified wallet-signature
   claim made for the project's token, or that token's recorded deployer, while HEY holds the token as the project's
   own. A renamed project's old slug keeps working.
3. **Release.** When the count since the bounty opened reaches the target, anyone asks HEY for a signed attestation
   and submits it. The escrow pays the builder and sends the burn share to `0x…dEaD`.
4. **Or refund.** If the target isn't met by the deadline (plus a 3-day grace for ships made before it), each backer
   takes back exactly what they put in.

### The flywheel

Backers put $WIF to work instead of leaving it idle → builders ship things for Robinhood Chain, many of them for $WIF
itself → every payout is $WIF in a builder's hands and a slice burned → more working utility gives more holders a
reason to back the next builder.

## Contract

`src/ShipEscrow.sol` — one contract, no owner, no admin function, no upgrade.

| Function | Who | What |
| --- | --- | --- |
| `create(token, builder, slug, minShips, deadline, burnBps, amount)` | anyone | opens a bounty; `project = keccak256(slug)`, `start = now` |
| `fund(id, amount)` | anyone | adds to an open bounty (credits what actually arrived) |
| `claim(id, ships, signature)` | anyone | pays the bounty's builder when HEY's signature says `ships ≥ minShips` |
| `refund(id)` | each funder | returns their own contribution after `deadline + 3 days` if unclaimed |

The attestation is EIP-712 (`"HEY Proof of Ship"`, version `1`, chain 4663, this contract):

```
Ships(bytes32 project, address builder, uint64 since, uint64 until, uint32 ships, bytes32 evidence, uint64 issuedAt)
```

`builder` must equal the bounty's payout address — HEY signs only for an address the project verified to HEY —
`since` must equal the bounty's start, `until` can't pass its deadline, `issuedAt` must be within the last day, and
`evidence` is the hash of the exact ship ids (`ship:<uuid>`) the count rests on, each of which opens on HEY with its
source. HEY signs at `GET https://heyresearch.xyz/api/v1/proof-of-ship/attestation?slug=&builder=&since=&until=&escrow=`.

## How it is built to be trusted

- **No owner, no admin key, no upgrade.** The only ways $WIF leaves the escrow are a release to the builder the bounty
  named (minus its burn share) and a refund of each backer's own contribution.
- **Source verified** on [Sourcify](https://repo.sourcify.dev/4663/0x3Da17a89F1d29aB96419269514C798a8dd6125f2)
  (exact match), so the code anyone reads is the code that holds the $WIF.
- **33 contract tests** (unit, fuzz with 2,000 runs, and attacks: impostor payees, replays across bounties, escrows and
  chains, malleable signatures, reentrant tokens) plus a fork test that runs the whole flow against the real $WIF on
  Robinhood Chain.
- **Reviewed adversarially, twice.** Before mainnet an independent review found that the payout address was not part
  of the signed data, so an impostor bounty could have been paid by a real project's ships; the attestation now
  signs the builder, and the escrow checks it. After launch HEY's full audit found two ways to game the count; both
  are closed: HEY signs only for a wallet tied to the project's *current* token (never a disowned, contested or
  issuer token), and counts at most one ship of each kind per day, first recorded inside the bounty window.
- **A guardian that can only stop.** If HEY's signing key were ever lost, a separate cold key can retire the escrow:
  claims stop and every backer can take their $WIF back at once. It cannot move a single token anywhere else.
- **No third-party script on the page.** viem is bundled into `app/vendor/`, and the page sets
  `script-src 'self'`.

## What HEY's signature means, and doesn't

It means: HEY counted this many ships for this project in this window, by the same rule as activity status on
heyresearch.xyz. It does not mean the project is good, safe or worth anything, and it changes nothing on HEY: no
status, score or order reads a bounty.

## Develop

```
forge install
forge test                                             # 24 unit and fuzz tests
FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc Fork   # the full flow with the real $WIF, local fork
```

The page in `app/` is static: `python3 -m http.server -d app`. It loads no third-party script: viem 2.21.55 is
vendored in `app/vendor/viem.js` (bundled once with esbuild from the npm package, the functions `app.js` imports), and
the page's Content-Security-Policy allows scripts from its own origin only.

## Deployment

| | Robinhood Chain (4663) |
| --- | --- |
| ShipEscrow | [`0x3Da17a89F1d29aB96419269514C798a8dd6125f2`](https://robinhoodchain.blockscout.com/address/0x3da17a89f1d29ab96419269514c798a8dd6125f2) · source verified on [Sourcify](https://repo.sourcify.dev/4663/0x3Da17a89F1d29aB96419269514C798a8dd6125f2) (exact match) |
| Attester (HEY) | [`0x2b309b352Ff49d04912Ca34984B27a5481325760`](https://robinhoodchain.blockscout.com/address/0x2b309b352ff49d04912ca34984b27a5481325760) |
| Guardian (retire only) | [`0x2f7D93Eed05439bFf41e602f37A8792Af731b736`](https://robinhoodchain.blockscout.com/address/0x2f7d93eed05439bff41e602f37a8792af731b736) |
| Deploy transaction | [`0xef19…d071`](https://robinhoodchain.blockscout.com/tx/0xef19bc5c4a756a66365f797a27c4223ab65c69c2d55ccb675d4dd1acd22ed071), block 96,136,035 |
| $WIF | [`0x5173b8eA6923c2d40267890D45C46a3480954773`](https://robinhoodchain.blockscout.com/token/0x5173b8ea6923c2d40267890d45c46a3480954773) |

Deployed by a person from their own wallet, never from CI:
`ATTESTER=0x… forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account <keystore>`.

Not affiliated with Robinhood. Not financial advice. See [SECURITY.md](SECURITY.md).
