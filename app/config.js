// Proof of Ship — deployment config. Fill ESCROW after the contract is deployed on Robinhood Chain.
export const CONFIG = {
  chainId: 4663,
  chainName: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  nativeSymbol: 'ETH',
  // The ShipEscrow contract on Robinhood Chain.
  escrow: '0x3Da17a89F1d29aB96419269514C798a8dd6125f2',
  // The block it was deployed in, so the page reads its events from there.
  escrowFromBlock: 96136035n,
  // HEY's attester (fixed in the escrow).
  attester: '0x2b309b352Ff49d04912Ca34984B27a5481325760',
  // $WIF — World is Flat (18 decimals).
  token: { address: '0x5173b8eA6923c2d40267890D45C46a3480954773', symbol: 'WIF', decimals: 18 },
  hey: 'https://heyresearch.xyz',
  // WalletConnect (Reown) project id: a public client id, not a secret.
  walletConnectProjectId: 'b8709ab016a2aab097cb19acc707188c',
};
