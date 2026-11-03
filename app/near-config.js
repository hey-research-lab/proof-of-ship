// Proof of Ship on NEAR: deployment config (hey-research-lab/proof-of-ship-near). NEAR mainnet only: the testnet
// escrow trusts a public test key, so HEY never signs for it and this page never shows it.
export const NEAR = {
  networkId: 'mainnet',
  // EIP-712 chain id HEY signs NEAR mainnet attestations under (398 is testnet, never used here).
  chainId: 397,
  // Read-only JSON-RPC, tried in order. Neither needs a key.
  rpcs: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
  explorer: 'https://nearblocks.io',
  // The escrow account. No full-access key is left on it, so nobody can redeploy its code.
  escrow: 'escrow.heyresearch.near',
  // USDC on NEAR (NEP-141, 6 decimals), the one token the escrow holds.
  token: { account: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 },
  // HEY's attester, fixed in the escrow at init (the same key that signs for Robinhood Chain).
  attester: '0x2b309b352Ff49d04912Ca34984B27a5481325760',
  // The NEAR Intents verifier an `intents` payout deposits into.
  intents: 'intents.near',
  // Can only retire the escrow: stop claims and open refunds. It can move no token.
  guardian: 'heyresearch.near',
  // How HEY's attestation route names this escrow (`escrow=near:<account id>`).
  heyEscrow: 'near:escrow.heyresearch.near',
  hey: 'https://heyresearch.xyz',
  repo: 'https://github.com/hey-research-lab/proof-of-ship-near',
};
