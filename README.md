# Proof of Ship

Put $WIF behind a team building on Robinhood Chain. It reaches them only when
[Hey Research Lab](https://heyresearch.xyz) counts real ships for that team — releases, deployed contracts, code that
changed — each with its public source. No ships by the deadline, and every backer takes their $WIF back.

[![CI](https://github.com/hey-research-lab/proof-of-ship/actions/workflows/ci.yml/badge.svg)](https://github.com/hey-research-lab/proof-of-ship/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Robinhood Chain 4663](https://img.shields.io/badge/Robinhood%20Chain-4663-informational.svg)](#deployment)

Built for the [World is Flat hackathon](https://worldisflat.fun/build).

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
   count.
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
Ships(bytes32 project, uint64 since, uint64 until, uint32 ships, bytes32 evidence, uint64 issuedAt)
```

`since` must equal the bounty's start, `until` can't pass its deadline, `issuedAt` must be within the last day, and
`evidence` is the hash of the exact ship ids (`ship:<uuid>`) the count rests on, each of which opens on HEY with its
source. HEY signs at `GET https://heyresearch.xyz/api/v1/proof-of-ship/attestation?slug=&since=&until=&escrow=`.

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

The page in `app/` is static (viem from a CDN, no build step): `python3 -m http.server -d app`.

## Deployment

| | Robinhood Chain (4663) |
| --- | --- |
| ShipEscrow | not deployed yet |
| Attester | — |
| $WIF | [`0x5173b8eA6923c2d40267890D45C46a3480954773`](https://robinhoodchain.blockscout.com/token/0x5173b8ea6923c2d40267890d45c46a3480954773) |

Deployed by a person from their own wallet, never from CI:
`ATTESTER=0x… forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account <keystore>`.

Not affiliated with Robinhood. Not financial advice. See [SECURITY.md](SECURITY.md).
