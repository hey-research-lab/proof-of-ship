# Security policy

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security → Advisories) on this repository, or
email hi@heyresearch.xyz with "security" in the subject. Do not open a public issue. We aim to acknowledge within
3 working days. There is no bug bounty for this repository.

## What the escrow trusts

- **No owner, no admin.** `ShipEscrow` has no owner and no function that moves tokens except `claim` (to the bounty's
  own builder, minus its burn share) and `refund` (each funder's own contribution, after the claim window).
- **The attester.** One address, fixed at deployment, signs the ship counts and the payout address. HEY signs only for a
  payout address the project itself verified to HEY, so a bounty opened for a project with someone else's address can
  never be claimed (its backers take their tokens back after the window). A compromised attester can release a bounty
  early to the builder its creator named; it cannot redirect funds or touch refunds of claimed bounties.
- **Signatures** are EIP-712, bound to this chain and this contract, carry the bounty's exact start, its payout address,
  a window that ends by the deadline, and expire after one day. One attestation can release several bounties for the
  same project and payout address that opened in the same second; that is intended (they asked for the same thing).
- **Token.** One ERC-20, fixed at deployment ($WIF on Robinhood Chain). Tokens sent to the escrow outside `create` or
  `fund` cannot be recovered.
