<a href="https://hey-research-lab.github.io/proof-of-ship/">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.svg">
    <img alt="Proof of Ship. Back a Robinhood Chain builder with $WIF. It pays out only when they ship." src="docs/hero-light.svg" width="100%">
  </picture>
</a>

<p align="center">
  <a href="https://github.com/hey-research-lab/proof-of-ship/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hey-research-lab/proof-of-ship/ci.yml?branch=main&style=flat-square&label=contract%20tests&color=4F7A00&labelColor=1F242B"></a>
  <a href="https://repo.sourcify.dev/4663/0x3Da17a89F1d29aB96419269514C798a8dd6125f2"><img alt="Source verified on Sourcify" src="https://img.shields.io/badge/Sourcify-exact%20match-C2FB03?style=flat-square&color=0B0E11&labelColor=1F242B"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-C2FB03?style=flat-square&color=0B0E11&labelColor=1F242B"></a>
</p>

<p align="center">
  <a href="https://hey-research-lab.github.io/proof-of-ship/"><b>Open the app</b></a> ·
  <a href="https://hey-research-lab.github.io/proof-of-ship/demo.html"><b>Watch the demo</b></a> ·
  <a href="https://worldisflat.fun/build/projects/proof-of-ship"><b>Follow on World is Flat</b></a> ·
  <a href="https://heyresearch.xyz"><b>Hey Research Lab</b></a>
</p>

**Proof of Ship** is an escrow on Robinhood Chain that pays builders in $WIF for shipping, not for promising. Anyone
locks $WIF behind a team, and it is released only when [Hey Research Lab](https://heyresearch.xyz) counts real ships
for that team, each with its public source; if the target is not met by the deadline, every backer takes their $WIF back.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/stats-dark.svg">
  <img alt="Proof of Ship, live from Robinhood Chain: $WIF locked now, paid to builders, burned, bounties opened and paid out" src="docs/stats-light.svg" width="100%">
</picture>

## Bounties

<!-- bounties:start -->
2 bounties on chain, newest first. Read from the escrow's events every day; each bounty number opens its card in the app.

| Bounty | Project | Amount | Target | Deadline | Status | Opened |
| :-- | :-- | --: | :-- | :-- | :-- | :-- |
| [#1](https://hey-research-lab.github.io/proof-of-ship/#bounty-1) | [fly-ai](https://heyresearch.xyz/project/fly-ai) | 5,000 WIF | 3 ships | 10 Nov 2026, 19:38 UTC | **Open** | [`0x9fa0…8c6d`](https://robinhoodchain.blockscout.com/tx/0x9fa062076690c34b94c11bae8c7c57cb73cd89e1677937029913d7175e9d8c6d) |
| [#0](https://hey-research-lab.github.io/proof-of-ship/#bounty-0) | [predict-fwa](https://heyresearch.xyz/project/predict-fwa) | 5,000 WIF | 3 ships | 6 Nov 2026, 18:25 UTC | **Paid** at 3 ships: 4,900 WIF to the builder, 100 burned · [`0xd196…ab57`](https://robinhoodchain.blockscout.com/tx/0xd19654c02474c71beb664e8b35aefc0e57eefaa8330707037245b3e95285ab57) | [`0x3e48…5603`](https://robinhoodchain.blockscout.com/tx/0x3e48e2d8ff9cb942bb580a8434f2ab4c4bc89e48e103f4c9dbb49e8ff6535603) |
<!-- bounties:end -->

## Try it

| | |
| :-- | :-- |
| **The app** | [hey-research-lab.github.io/proof-of-ship](https://hey-research-lab.github.io/proof-of-ship/): open a bounty, add $WIF to one, release it or take a refund. Bounties and stats are read straight from the chain, so looking needs no wallet. |
| **The demo** | [a short video of the whole flow](https://hey-research-lab.github.io/proof-of-ship/demo.html), from opening a bounty to the release. |
| **Follow the build** | [Proof of Ship on World is Flat](https://worldisflat.fun/build/projects/proof-of-ship): every update, and a vote when voting opens. Built for the [World is Flat hackathon](https://worldisflat.fun/build). |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/app-dark.png">
    <img alt="The Proof of Ship app: the hero, the live stats and the three steps" src="docs/app-light.png" width="100%">
  </picture>
</p>

## Why you can trust it

| | |
| :-- | :-- |
| **No owner and no admin key** | No one can upgrade the contract or send its $WIF anywhere else. It leaves the escrow only as a release to the payout wallet the bounty named, minus its burn share, or as each backer's own refund. |
| **A guardian that can only stop** | A separate cold key can retire the escrow if HEY's signing key were ever lost. Claims stop and every backer can refund at once. It cannot send a single token anywhere else. |
| **HEY signs a count, not a verdict** | The signature says how many ships HEY counted for the project in the bounty's window. It does not say the project is good, safe or worth funding. |
| **One ship of each kind a day** | For a bounty, HEY counts at most one release, one contract deployment or upgrade, one code week and one other entry per day, and only ships it first recorded inside the window. |
| **Paid only to a wallet HEY ties to the project** | Either the deployer of the project's token, once HEY reads that token as the project's own, or a wallet that signed the project's claim on HEY for that token. HEY never signs for any other address. |
| **Source verified** | [Sourcify exact match](https://repo.sourcify.dev/4663/0x3Da17a89F1d29aB96419269514C798a8dd6125f2): the code in `src/` is the code that holds the $WIF. 38 contract tests, with fuzz tests at 2,000 runs, including the whole flow against the real $WIF on a fork (run when `FORK_RPC` is set). |

## For builders

There is nothing to apply for. Keep shipping on Robinhood Chain; when someone backs you, HEY counts what you ship
the same way it does on every project page.

Check whether HEY can pay you, before anyone opens a bounty:

```
GET https://heyresearch.xyz/api/v1/proof-of-ship/tie?slug=<your-slug>
```

It answers `payable` and the addresses HEY ties to your project (`token_deployer` or `wallet_claim`). If it ties none,
claim your page on [heyresearch.xyz](https://heyresearch.xyz) with a wallet signature for your token, or pay out to the
wallet that deployed your token. In the app, connect your payout wallet and a banner shows what is waiting for you:
the amount, HEY's signed count against the target, and the deadline.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/flow-dark.svg">
  <img alt="Back: anyone locks $WIF. Ship: the builder ships from public sources. HEY counts: an EIP-712 signed count. Release to the builder, or refund after the deadline plus 3 days." src="docs/flow-light.svg" width="100%">
</picture>

| Step | What happens |
| :-- | :-- |
| **1. Back** | Anyone opens a bounty for a project with a page on HEY (`heyresearch.xyz/project/<slug>`): the builder's payout wallet, how many ships, a deadline, a burn share of 0 to 10%, and the $WIF to lock. Anyone can add more. |
| **2. Ship** | The builder ships. HEY counts by the rule it uses on every page: corroborated building evidence. A repository's releases of one day count once, a deploy script's contracts count once, and docs-only weeks, dependency bumps, CI-only commits and automation never count. A code week counts only once it has ended inside the window. |
| **3. HEY counts** | At the target, anyone asks HEY for a signed count. HEY signs it as EIP-712 typed data for that payout wallet and that window, with the hash of the exact ship ids it rests on. |
| **4. Release, or refund** | Anyone submits the count; the escrow pays the builder and burns the share the backer chose. Target not met by the deadline, plus a 3-day grace for ships made before it? Every backer takes back exactly what they put in. |

<details>
<summary><b>Contracts and addresses</b></summary>

| | Robinhood Chain (4663) |
| :-- | :-- |
| **ShipEscrow** | [`0x3Da17a89F1d29aB96419269514C798a8dd6125f2`](https://robinhoodchain.blockscout.com/address/0x3da17a89f1d29ab96419269514c798a8dd6125f2) · source on [Sourcify](https://repo.sourcify.dev/4663/0x3Da17a89F1d29aB96419269514C798a8dd6125f2) (exact match) |
| **Attester** (Hey Research Lab) | [`0x2b309b352Ff49d04912Ca34984B27a5481325760`](https://robinhoodchain.blockscout.com/address/0x2b309b352ff49d04912ca34984b27a5481325760) |
| **Guardian** (can only retire) | [`0x2f7D93Eed05439bFf41e602f37A8792Af731b736`](https://robinhoodchain.blockscout.com/address/0x2f7d93eed05439bff41e602f37a8792af731b736) |
| **$WIF** | [`0x5173b8eA6923c2d40267890D45C46a3480954773`](https://robinhoodchain.blockscout.com/token/0x5173b8ea6923c2d40267890d45c46a3480954773) |
| **Deployed** | [`0xef19…d071`](https://robinhoodchain.blockscout.com/tx/0xef19bc5c4a756a66365f797a27c4223ab65c69c2d55ccb675d4dd1acd22ed071), block 96,136,035 |
| **Burn address** | `0x000000000000000000000000000000000000dEaD`, at release only. A refunded bounty burns nothing. |

`src/ShipEscrow.sol` is one contract:

| Function | Who | What |
| :-- | :-- | :-- |
| `create(token, builder, slug, minShips, deadline, burnBps, amount)` | anyone | opens a bounty; `project = keccak256(slug)`, `start = now` |
| `fund(id, amount)` | anyone | adds to an open bounty (credits what actually arrived) |
| `claim(id, ships, signature)` | anyone | pays the bounty's builder when HEY's signature says `ships >= minShips` |
| `refund(id)` | each backer | returns their own contribution after `deadline + 3 days`, if unclaimed |
| `retire()` | guardian | stops claims for good and opens refunds at once |

</details>

<details>
<summary><b>The EIP-712 type HEY signs</b></summary>

Domain `"HEY Proof of Ship"`, version `1`, chain 4663, this contract as `verifyingContract`:

```solidity
Ships(bytes32 project, address builder, uint64 since, uint64 until, uint32 ships, bytes32 evidence, uint64 issuedAt)
```

`project` is `keccak256` of the project's HEY slug. `builder` must equal the bounty's payout wallet, `since` its start,
`until` cannot pass its deadline, `issuedAt` is within the last day, and `evidence` hashes the exact sorted ship ids
(`ship:<uuid>`) the count rests on; each opens on HEY with its source.

It means HEY counted this many ships for this project in this window, by the same rule as activity status on
heyresearch.xyz. It changes nothing on HEY: no status, score or order reads a bounty. HEY holds, moves and earns
nothing in an escrow.

</details>

<details>
<summary><b>The HEY endpoints the app uses</b></summary>

All public, no key. The page reads them from your browser; it loads no third-party script (viem and WalletConnect are
bundled into `app/vendor/` and the page sets `script-src 'self'`).

| Endpoint | For |
| :-- | :-- |
| `GET /api/v1/proof-of-ship/attestation?slug=&builder=&since=&until=&escrow=` | the signed count a release submits; also how the page checks a payout wallet as you type |
| `GET /api/v1/proof-of-ship/tie?slug=` | the addresses HEY ties to a project, to fill in or offer the payout wallet |
| `GET /api/projects/<slug>` | the project card on a bounty, and its official X for a post that tells the builder |
| `GET /api/projects/<slug>/timeline` | the ships HEY counted, up to five on each card, with the day HEY first recorded each |
| `GET /api/search/suggest?q=` | the project field, which writes the project's exact slug when you pick one |

</details>

<details>
<summary><b>What is in the app</b></summary>

<table>
  <tr>
    <td width="68%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/compose-dark.png">
        <img alt="Opening a bounty with a live preview of what it pays and burns" src="docs/compose-light.png" width="100%">
      </picture>
    </td>
    <td width="32%"><img alt="Proof of Ship on a phone" src="docs/mobile-dark.png" width="100%"></td>
  </tr>
  <tr>
    <td><sub>Open a bounty: HEY's card for the project, a payout wallet checked against HEY's tie rule as you type, and a live preview of what it pays, burns and when refunds open.</sub></td>
    <td><sub>Works at 375 px, light and dark. On a phone with no wallet it opens the page in MetaMask, Coinbase, Trust or OKX, or connects through WalletConnect.</sub></td>
  </tr>
</table>

- **Wallets:** browser wallets (EIP-6963, each extension listed) and WalletConnect, a *Switch to Robinhood Chain* prompt
  on the wrong network, an account menu with copy, explorer and disconnect. The last wallet comes back on reload
  without a prompt.
- **Opening a bounty:** the project field searches HEY as you type and writes the project's exact slug when you pick
  one; a slug typed by hand is used exactly as typed. The payout wallet is filled in when HEY ties one address to the
  project, offered as a choice when it ties two, and the page says plainly when it ties none (such a bounty can only be
  refunded after its deadline). Time to ship is 7, 14 or 30 days, or any 1 to 365.
- **Each bounty card** has its own address (`#bounty-<id>`), a *Share on X* link with a factual post and a *Copy link*
  button. An open bounty's *Tell the builder* link drafts a post that tags the project's official X only when HEY reads
  the account as active and holds no hold on it.

</details>

<details>
<summary><b>Build and verify</b></summary>

```bash
forge install
forge test                                                              # 37 tests; the fork test skips without FORK_RPC
FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc Fork   # the full flow with the real $WIF
python3 -m http.server -d app                                           # the app: static, no build step
sh vendor-build/build.sh                                                # rebuild app/vendor and check SHA256SUMS
node --no-warnings scripts/stats.mjs                                    # redraw this README's pictures and table
```

Deployed by a person from their own wallet, never from CI:
`ATTESTER=0x… GUARDIAN=0x… forge script script/Deploy.s.sol --rpc-url robinhood --broadcast`.

The stats card and the bounties table are redrawn once a day by [`.github/workflows/stats.yml`](.github/workflows/stats.yml)
from the escrow's own events on Robinhood Chain. A read that fails, or that disagrees with the contract's own
`bountyCount()` and balance, writes nothing, so the last good figures stay.

</details>

<details>
<summary><b>Security</b></summary>

Before mainnet, an independent adversarial review found that the payout wallet was not signed, so an impostor bounty
could have been paid by a real project's ships. Now HEY signs it and the escrow checks it. After launch, HEY's full
audit found two ways to game the count: work pushed after the deadline and dated back, and many small entries in one
day. Both are closed: only ships first recorded inside the window count, and at most one of each kind a day.

The tests cover impostor payees, replays across bounties, escrows and chains, malleable signatures and reentrant tokens
([`test/ShipEscrow.replay.t.sol`](test/ShipEscrow.replay.t.sol) holds the last three: a chain-id change, a high-s signature and
a token hook re-entering `claim`, `refund` and `fund`).
What the escrow trusts, and how to report a vulnerability privately: [SECURITY.md](SECURITY.md).

</details>

<details>
<summary><b>Questions</b></summary>

**Can I open a bounty for any project?** Any project with a page on HEY. The payout wallet must be one HEY ties to that
project. If it is not, HEY never signs, and backers refund after the deadline. The app checks the wallet as you type.

**What if HEY disappears?** Every bounty refunds after its deadline plus 3 days, without HEY. If HEY's key were ever
compromised, the guardian retires the escrow and refunds open at once.

**A project was renamed on HEY.** Its old slug keeps working: HEY signs for the slug the bounty was opened with.

</details>

<p align="center">
  <sub>By <a href="https://heyresearch.xyz">Hey Research Lab</a> · <a href="SECURITY.md">Security</a> · <a href="LICENSE">MIT</a> · Not affiliated with or endorsed by Robinhood · Not financial advice</sub>
</p>
