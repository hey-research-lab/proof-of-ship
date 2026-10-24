import {
  createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, getAddress, isAddress,
} from './vendor/viem.js?v=5';
import { CONFIG } from './config.js?v=8';

const chain = {
  id: CONFIG.chainId, name: CONFIG.chainName,
  nativeCurrency: { name: 'Ether', symbol: CONFIG.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CONFIG.explorer } },
};
const pub = createPublicClient({ chain, transport: http(CONFIG.rpc) });
const ABI = await (await fetch('./ShipEscrow.abi.json?v=5')).json();
const ERC20 = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const GRACE = 3 * 86400;
const T = CONFIG.token;
const $ = (s) => document.querySelector(s);
let wallet = null, account = null;

// ------------------------------------------------------------------ helpers
let toastTimer;
const toast = (msg, sticky = false) => {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = msg || '';
  if (msg && !sticky) toastTimer = setTimeout(() => { $('#toast').innerHTML = ''; }, 5000);
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const fmt = (v) => num(formatUnits(v, T.decimals));
const compact = (v) => {
  const n = Number(formatUnits(v, T.decimals));
  return n >= 1e6 ? `${num(n / 1e6, 2)}M` : n >= 1e4 ? `${num(n / 1e3, 1)}K` : num(n);
};
const day = (s) => new Date(Number(s) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const now = () => Math.floor(Date.now() / 1000);
const tx = (h) => `${CONFIG.explorer}/tx/${h}`;
const addrUrl = (a) => `${CONFIG.explorer}/address/${a}`;
const logo = (url, name) => url
  ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph'}))">`
  : `<span class="ph" aria-hidden="true" title="${esc(name)}"></span>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ------------------------------------------------------------------ wallet
// ------------------------------------------------------------------ wallet discovery (EIP-6963 + injected fallback)
const discovered = new Map();
window.addEventListener('eip6963:announceProvider', (event) => {
  const d = event.detail;
  if (d?.info?.uuid && d.provider) discovered.set(d.info.uuid, d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
let provider = null;
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const pageUrl = () => location.href.split('#')[0];
const DEEP_LINKS = [
  { name: 'MetaMask', href: () => `https://metamask.app.link/dapp/${pageUrl().replace(/^https?:\/\//, '')}` },
  { name: 'Coinbase Wallet', href: () => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(pageUrl())}` },
  { name: 'Trust Wallet', href: () => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(pageUrl())}` },
  { name: 'OKX Wallet', href: () => `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(pageUrl())}` },
];

function openWalletPicker() {
  const dlg = $('#wallets');
  const list = $('#walletList');
  const options = [...discovered.values()];
  let html = CONFIG.walletConnectProjectId
    ? `<button class="wallet" data-wc="1"><span>WalletConnect</span><span class="go-arrow" aria-hidden="true">QR · mobile</span></button>`
    : '';
  if (options.length) {
    html += options.map((d) => `<button class="wallet" data-uuid="${esc(d.info.uuid)}"><img src="${esc(d.info.icon)}" alt="" width="28" height="28"><span>${esc(d.info.name)}</span></button>`).join('');
  } else if (window.ethereum) {
    html += `<button class="wallet" data-uuid="injected"><span>Browser wallet</span></button>`;
  }
  if (!options.length && !window.ethereum) {
    html += isMobile()
      ? `<p class="hint">On a phone, open this page inside your wallet app's browser:</p>` +
        DEEP_LINKS.map((w) => `<a class="wallet" href="${esc(w.href())}" rel="noopener"><span>Open in ${esc(w.name)}</span><span class="go-arrow" aria-hidden="true">↗</span></a>`).join('') +
        `<button class="wallet" data-copy="1"><span>Copy link for another wallet</span></button>`
      : `<p class="hint">No wallet found in this browser. Install <a href="https://rabby.io" target="_blank" rel="noopener">Rabby</a> or <a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a>, then reload. Reading bounties needs no wallet.</p>`;
  }
  list.innerHTML = html;
  list.querySelectorAll('[data-uuid]').forEach((el) => el.addEventListener('click', () => {
    const d = discovered.get(el.dataset.uuid);
    const chosen = el.dataset.uuid === 'injected' ? window.ethereum : d?.provider;
    dlg.close();
    if (chosen) useProvider(chosen, d ? { kind: d.info.rdns, name: d.info.name, icon: d.info.icon } : { kind: 'injected', name: 'Browser wallet' }).catch(fail);
  }));
  list.querySelector('[data-wc]')?.addEventListener('click', () => { dlg.close(); connectWalletConnect().catch(fail); });
  list.querySelector('[data-copy]')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pageUrl()); toast('Link copied. Paste it in your wallet app’s browser.'); } catch { toast(pageUrl()); }
  });
  dlg.showModal();
}

const wcMeta = (wc) => ({ kind: 'walletconnect', name: wc.session?.peer?.metadata?.name ? `${wc.session.peer.metadata.name} · WalletConnect` : 'WalletConnect', icon: wc.session?.peer?.metadata?.icons?.[0] });
async function initWalletConnect(showQrModal) {
  const { EthereumProvider } = await import('./vendor/walletconnect.js');
  return EthereumProvider.init({
    projectId: CONFIG.walletConnectProjectId,
    optionalChains: [chain.id],
    rpcMap: { [chain.id]: CONFIG.rpc },
    showQrModal,
    metadata: {
      name: 'Proof of Ship',
      description: 'Back a Robinhood Chain builder with $WIF. Pay them when they ship.',
      url: location.origin + location.pathname.replace(/[^/]*$/, ''),
      icons: [],
    },
  });
}
/** WalletConnect v2, loaded only when chosen (vendor/walletconnect.js, @walletconnect/ethereum-provider 2.26.0). */
async function connectWalletConnect() {
  toast('Opening WalletConnect…', true);
  const wc = await initWalletConnect(true);
  toast('');
  await wc.connect();
  await useProvider(wc, wcMeta(wc));
}

async function connect() {
  // Give EIP-6963 wallets a moment to announce themselves on a cold page.
  if (!discovered.size) { window.dispatchEvent(new Event('eip6963:requestProvider')); await new Promise((r) => setTimeout(r, 150)); }
  const options = [...discovered.values()];
  // Inside a wallet app's own browser there is one wallet and nothing to choose: connect it.
  if (isMobile() && (options.length === 1 || (!options.length && window.ethereum))) return useProvider(options[0]?.provider ?? window.ethereum, options[0] ? { kind: options[0].info.rdns, name: options[0].info.name, icon: options[0].info.icon } : { kind: 'injected', name: 'Browser wallet' });
  // Elsewhere one wallet and no WalletConnect: connect it; otherwise let the reader choose.
  if (!CONFIG.walletConnectProjectId && options.length === 1) return useProvider(options[0].provider, { kind: options[0].info.rdns, name: options[0].info.name, icon: options[0].info.icon });
  if (!CONFIG.walletConnectProjectId && !options.length && window.ethereum) return useProvider(window.ethereum, { kind: 'injected', name: 'Browser wallet' });
  openWalletPicker();
}

let walletInfo = null;
const SAVED = 'pos.wallet';
const remember = (kind) => { try { kind ? localStorage.setItem(SAVED, kind) : localStorage.removeItem(SAVED); } catch { /* private mode */ } };

function renderAccount() {
  const on = Boolean(account);
  $('#connect').hidden = on;
  $('#account').hidden = !on;
  if (!on) { $('#accountMenu').hidden = true; return; }
  const icon = walletInfo?.icon ? `<img src="${esc(walletInfo.icon)}" alt="" width="18" height="18">` : '<span class="dot"></span>';
  $('#account').innerHTML = `${icon}<span>${short(account)}</span>${heldWif !== null ? `<span class="muted">${compact(heldWif)} ${T.symbol}</span>` : ''}`;
  $('#acctWallet').textContent = walletInfo?.name ?? 'Wallet';
  $('#acctAddr').textContent = account;
  $('#acctWif').textContent = heldWif !== null ? `${fmt(heldWif)} ${T.symbol}` : '—';
  $('#acctExplorer').href = addrUrl(account);
}

async function useProvider(p, info = { kind: 'injected', name: 'Browser wallet' }, silent = false) {
  provider = p;
  walletInfo = info;
  wallet = createWalletClient({ chain, transport: custom(provider) });
  if (silent) {
    const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
    if (!accounts?.length) { provider = null; wallet = null; walletInfo = null; return; }
    account = getAddress(accounts[0]);
  } else {
    [account] = await wallet.requestAddresses();
  }
  remember(info.kind);
  renderAccount();
  // Balances are read from Robinhood Chain directly, whatever network the wallet is on.
  showBalance();
  if (silent) await showNetwork(); else await ensureChain(false);
  provider.on?.('accountsChanged', (a) => {
    account = a?.[0] ? getAddress(a[0]) : null;
    heldWif = null;
    renderAccount();
    if (account) showBalance();
    load();
  });
  provider.on?.('chainChanged', () => showNetwork());
  provider.on?.('disconnect', () => { if (walletInfo?.kind === 'walletconnect') clearWallet(); });
  await load();
}

function clearWallet() {
  account = null; provider = null; wallet = null; walletInfo = null; heldWif = null;
  remember(null);
  $('#switchNet').hidden = true;
  $('#balHint').textContent = '';
  renderAccount();
  renderPreview();
  restoreWallet().catch(() => undefined).finally(() => { if (!account) load().catch(fail); });
}

async function disconnect() {
  const p = provider;
  const kind = walletInfo?.kind;
  clearWallet();
  try {
    if (kind === 'walletconnect') await p?.disconnect?.();
    // Injected wallets: drop this site's permission where the wallet supports it (MetaMask, Rabby); the page forgets either way.
    else await p?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch { /* not every wallet supports revoking */ }
  toast('Disconnected.');
}

/** Bring back the last wallet without a prompt: an injected wallet that still lists this site, or a live WalletConnect session. */
async function restoreWallet() {
  let kind = null;
  try { kind = localStorage.getItem(SAVED); } catch { return; }
  if (!kind) return;
  if (kind === 'walletconnect') {
    if (!CONFIG.walletConnectProjectId) return;
    const wc = await initWalletConnect(false).catch(() => null);
    if (wc?.session) await useProvider(wc, wcMeta(wc), true);
    else remember(null);
    return;
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 300));
  const d = [...discovered.values()].find((x) => x.info.rdns === kind);
  const p = d?.provider ?? (kind === 'injected' ? window.ethereum : null);
  if (p) await useProvider(p, d ? { kind, name: d.info.name, icon: d.info.icon } : { kind, name: 'Browser wallet' }, true);
}

async function showNetwork() {
  if (!provider) return;
  const id = Number(await provider.request({ method: 'eth_chainId' }).catch(() => 0));
  $('#switchNet').hidden = id === chain.id;
  return id;
}
async function ensureChain(strict) {
  try { await wallet.switchChain({ id: chain.id }); } catch {
    try { await wallet.addChain({ chain }); await wallet.switchChain({ id: chain.id }); } catch {
      if (strict) throw new Error('Switch your wallet to Robinhood Chain (4663) to sign.');
    }
  }
  return showNetwork();
}
async function needWallet() { if (!account) await connect(); if (!account) throw new Error('Connect a wallet first.'); }
async function send(req, label) {
  if ((await showNetwork()) !== chain.id) await ensureChain(true);
  toast(`${label}: confirm in your wallet…`, true);
  const hash = await wallet.writeContract({ account, chain, ...req });
  toast(`${label}: waiting for <a href="${tx(hash)}" target="_blank" rel="noopener">the transaction</a>…`, true);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted.`);
  return hash;
}
async function ensureAllowance(amount) {
  const have = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'allowance', args: [account, CONFIG.escrow] });
  if (have >= amount) return;
  await send({ address: T.address, abi: ERC20, functionName: 'approve', args: [CONFIG.escrow, amount] }, `Approve ${fmt(amount)} ${T.symbol}`);
}
let heldWif = null;
async function showBalance() {
  if (!account) return;
  const bal = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [account] }).catch(() => null);
  if (bal === null) { $('#balHint').textContent = `Couldn't read your ${T.symbol} balance; try again.`; return; }
  heldWif = bal;
  renderAccount();
  renderPreview();
}

// ------------------------------------------------------------------ HEY reads (public API, no key)
const projectCache = new Map();
async function heyProject(slug) {
  if (projectCache.has(slug)) return projectCache.get(slug);
  const r = await fetch(`${CONFIG.hey}/api/projects/${encodeURIComponent(slug)}`);
  if (r.status === 404) { projectCache.set(slug, null); return null; }
  if (!r.ok) throw new Error(`HEY answered ${r.status}`);
  const j = await r.json();
  const p = j.project ?? j;
  projectCache.set(slug, p);
  return p;
}
/** HEY's signed count for a bounty window — the exact number the escrow releases on. */
async function heyAttestation(slug, builder, since, until) {
  const u = new URL(`${CONFIG.hey}/api/v1/proof-of-ship/attestation`);
  u.searchParams.set('slug', slug);
  u.searchParams.set('builder', builder);
  u.searchParams.set('since', String(since));
  u.searchParams.set('until', String(until));
  u.searchParams.set('escrow', CONFIG.escrow);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}
async function shipTitles(slug, ids) {
  const want = new Set(ids);
  if (!want.size) return [];
  const r = await fetch(`${CONFIG.hey}/api/projects/${encodeURIComponent(slug)}/timeline?limit=200`).catch(() => null);
  if (!r?.ok) return [];
  const j = await r.json();
  return (j.items ?? []).filter((it) => want.has(it.id));
}

// ------------------------------------------------------------------ composer
const form = $('#create');
function readForm() {
  const f = new FormData(form);
  const amountStr = String(f.get('amount') || '0');
  let amount = 0n;
  try { amount = parseUnits(amountStr, T.decimals); } catch { /* shown as 0 */ }
  return {
    slug: String(f.get('slug') || '').trim().toLowerCase(),
    builder: String(f.get('builder') || '').trim(),
    minShips: Math.max(0, Math.floor(Number(f.get('minShips')) || 0)),
    days: Math.max(0, Math.floor(Number(f.get('days')) || 0)),
    burnBps: Math.round(Math.min(10, Math.max(0, Number(f.get('burn')) || 0)) * 100),
    amount,
  };
}
function renderPreview() {
  const v = readForm();
  const burned = (v.amount * BigInt(v.burnBps)) / 10_000n;
  $('#pAmt').innerHTML = `${fmt(v.amount)}<small>${T.symbol}</small>`;
  $('#pPay').textContent = `${fmt(v.amount - burned)} ${T.symbol}`;
  $('#pBurn').textContent = `${fmt(burned)} ${T.symbol}`;
  $('#pShips').textContent = `${v.minShips || '—'} ship${v.minShips === 1 ? '' : 's'}`;
  const by = now() + v.days * 86400;
  $('#pBy').textContent = v.days ? day(by) : '—';
  $('#pRefund').textContent = v.days ? day(by + GRACE) : '—';
  $('#daysHint').textContent = v.days ? `Ships counted until ${day(by)}.` : '';
  const bh = $('#balHint'), btn = $('#openBtn');
  if (heldWif !== null) {
    const over = v.amount > heldWif;
    bh.className = over ? 'hint bad' : 'hint';
    bh.innerHTML = `${over ? 'More than you hold: ' : 'You hold '}${fmt(heldWif)} ${T.symbol}. <a href="#" id="useAll">Use all</a>`;
    btn.disabled = over;
  }
  const p = v.slug ? projectCache.get(v.slug) : undefined;
  const name = p?.name ?? (v.slug || 'the project');
  $('#pSentence').textContent = v.slug && isAddress(v.builder)
    ? `When HEY counts ${v.minShips} ship${v.minShips === 1 ? '' : 's'} for ${name} by ${day(by)}, ${fmt(v.amount - burned)} ${T.symbol} goes to ${short(v.builder)}. If not, you take your ${T.symbol} back.`
    : 'Enter a project and a payout address.';
}
const checkSlug = debounce(async () => {
  const { slug } = readForm();
  const hint = $('#slugHint'), card = $('#projectCard');
  hint.className = 'hint';
  if (!slug) { hint.innerHTML = 'The slug in heyresearch.xyz/project/<span class="mono">slug</span>'; card.className = 'project'; renderPreview(); return; }
  const p = await heyProject(slug).catch(() => undefined);
  if (p === null) { hint.className = 'hint bad'; hint.textContent = 'Not a published project on HEY.'; card.className = 'project'; }
  else if (p) {
    hint.className = 'hint ok'; hint.textContent = 'Found on HEY.';
    const last = p.lastShippedAt ? `last shipped ${day(Date.parse(p.lastShippedAt) / 1000)}` : 'no ship read yet';
    card.innerHTML = `${logo(p.logoUrl, p.name)}<div><b>${esc(p.name)}</b><span>${esc(String(p.activityStatus ?? '').toLowerCase().replace('_', ' '))} · ${last}</span></div>`;
    card.className = 'project on';
  }
  renderPreview();
  checkBuilder();
}, 350);
const checkBuilder = debounce(async () => {
  const { slug, builder } = readForm();
  const hint = $('#builderHint');
  hint.className = 'hint';
  if (!builder) { hint.textContent = "A wallet HEY ties to the project. It can't be changed later."; renderPreview(); return; }
  if (!isAddress(builder)) { hint.className = 'hint bad'; hint.textContent = 'Not a valid address.'; renderPreview(); return; }
  renderPreview();
  if (!slug || !CONFIG.escrow) return;
  const t = now() - 120;
  const res = await heyAttestation(slug, builder, t - 60, t).catch(() => null);
  if (!res) return;
  if (res.ok) {
    const how = res.body.builderTie === 'wallet_claim' ? 'it signed for the project’s token to claim the project on HEY' : 'it deployed the project’s verified token';
    hint.className = 'hint ok'; hint.textContent = `HEY ties this address to the project: ${how}.`;
  } else if (res.status === 403) {
    hint.className = 'hint bad'; hint.textContent = 'HEY doesn’t tie this address to the project, so it would never sign a payout to it.';
  }
}, 450);
form.addEventListener('click', (e) => {
  if (e.target.id !== 'useAll' || heldWif === null) return;
  e.preventDefault();
  $('#amount').value = formatUnits(heldWif, T.decimals);
  renderPreview();
});
form.addEventListener('input', (e) => {
  if (e.target.name === 'slug') checkSlug();
  else if (e.target.name === 'builder') checkBuilder();
  renderPreview();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#openBtn');
  try {
    if (!CONFIG.escrow) throw new Error('The escrow is not deployed yet.');
    const v = readForm();
    const bad = (id, hintId, msg) => { const h = $(hintId); h.className = 'hint bad'; h.textContent = msg; $(id).focus(); $(id).scrollIntoView({ behavior: 'smooth', block: 'center' }); return new Error(msg); };
    if (!v.slug) throw bad('#slug', '#slugHint', 'Type the project’s slug, e.g. predict-fwa.');
    if (!isAddress(v.builder)) throw bad('#builder', '#builderHint', 'Paste the builder’s payout address (0x…).');
    if (v.minShips < 1) throw new Error('A bounty needs at least one ship.');
    if (v.days < 1 || v.days > 365) throw new Error('Time to ship is 1 to 365 days.');
    const project = await heyProject(v.slug);
    if (!project) throw new Error(`HEY has no published project "${v.slug}".`);
    await needWallet();
    btn.disabled = true;
    const deadline = BigInt(now() + v.days * 86400);
    const bal = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [account] });
    if (v.amount > bal) throw new Error(`You hold ${fmt(bal)} ${T.symbol}; lower the amount to lock.`);
    if (v.amount > 0n) await ensureAllowance(v.amount);
    const hash = await send({ address: CONFIG.escrow, abi: ABI, functionName: 'create', args: [T.address, getAddress(v.builder), v.slug, v.minShips, deadline, v.burnBps, v.amount] }, 'Open bounty');
    toast(`Bounty opened. <a href="${tx(hash)}" target="_blank" rel="noopener">View transaction</a>`);
    await load();
    document.getElementById('bounties-section').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { fail(err); } finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ bounties
async function load() {
  const box = $('#bounties');
  if (!CONFIG.escrow) { box.innerHTML = '<div class="empty">The escrow is being deployed. Bounties appear here as soon as it is live.</div>'; return; }
  const [count, locked] = await Promise.all([
    pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bountyCount' }).then(Number),
    pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [CONFIG.escrow] }),
  ]);
  $('#sLocked').innerHTML = `${compact(locked)}<small>${T.symbol}</small>`;
  if (count === 0) {
    box.innerHTML = '<div class="empty">No bounties yet. Open the first one above.</div>';
    $('#sOpen').textContent = '0'; $('#sPaid').innerHTML = `0<small>${T.symbol}</small>`; $('#sBurned').innerHTML = `0<small>${T.symbol}</small>`;
    $('#bCount').textContent = '';
    return;
  }
  const ids = [...Array(count).keys()].reverse();
  const rows = await Promise.all(ids.map(async (id) => {
    const [b, slug] = await Promise.all([
      pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bounty', args: [BigInt(id)] }),
      pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'slugOf', args: [BigInt(id)] }),
    ]);
    return { id, b, slug };
  }));
  let paid = 0n, burned = 0n, open = 0;
  for (const { b } of rows) {
    if (b.paid) { const x = (b.total * BigInt(b.burnBps)) / 10_000n; burned += x; paid += b.total - x; }
    else if (now() <= Number(b.deadline) + GRACE) open++;
  }
  $('#sOpen').textContent = String(open);
  $('#sPaid').innerHTML = `${compact(paid)}<small>${T.symbol}</small>`;
  $('#sBurned').innerHTML = `${compact(burned)}<small>${T.symbol}</small>`;
  $('#bCount').textContent = `${count} bount${count === 1 ? 'y' : 'ies'} on chain`;
  box.innerHTML = (await Promise.all(rows.map(renderBounty))).join('');
  box.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => act(el.dataset.act, Number(el.dataset.id)).catch(fail)));
}

async function renderBounty({ id, b, slug }) {
  const until = Math.min(now() - 120, Number(b.deadline));
  const [project, mine, att] = await Promise.all([
    heyProject(slug).catch(() => null),
    account ? pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'contributed', args: [BigInt(id), account] }) : 0n,
    b.paid || until < Number(b.start) ? null : heyAttestation(slug, b.builder, Number(b.start), until).catch(() => null),
  ]);
  let have = null, ships = [], note = '';
  if (att?.ok) {
    have = Number(att.body.attestation.ships);
    ships = await shipTitles(slug, att.body.evidenceIds ?? []);
  } else if (att?.status === 403) {
    note = 'HEY doesn’t tie this payout address to the project, so it will never release. Backers can take their $WIF back after the deadline.';
  }
  // No signed count, no claim of one: HEY's timeline is not what the escrow releases on (it counts each kind once a day
  // and only ships HEY recorded inside the window), so the page says the count is unavailable rather than guess.
  const unavailable = !b.paid && !note && !att?.ok && until >= Number(b.start);
  const need = Number(b.minShips);
  const graceEnd = Number(b.deadline) + GRACE;
  const inWindow = !b.paid && now() <= graceEnd;
  const met = have !== null && have >= need;
  const state = b.paid ? ['ok', 'Paid out']
    : note ? ['off', 'Payout address not tied']
    : met && inWindow ? ['ok', 'Target met · ready to release']
    : unavailable && inWindow ? ['wait', 'HEY count unavailable · try again shortly']
    : now() > graceEnd ? ['off', 'Closed · backers can take back']
    : now() > Number(b.deadline) ? ['wait', 'Deadline passed · grace period']
    : ['wait', 'Building'];
  const pct = b.paid ? 100 : have === null ? 0 : Math.min(100, Math.round((have / need) * 100));
  const name = project?.name ?? slug;
  const actions = [];
  if (met && inWindow && !note) actions.push(`<button class="go" data-act="claim" data-id="${id}">Release to builder</button>`);
  if (!b.paid && now() < Number(b.deadline)) actions.push(`<button data-act="fund" data-id="${id}">Add ${T.symbol}</button><span class="fund-box" data-fund-box="${id}" hidden><input type="number" inputmode="decimal" min="0" step="any" placeholder="1000" aria-label="${T.symbol} to add"><button class="go" data-act="fund" data-id="${id}">Add</button></span>`);
  if (!b.paid && now() > graceEnd && mine > 0n) actions.push(`<button data-act="refund" data-id="${id}">Take back ${fmt(mine)} ${T.symbol}</button>`);
  const list = ships.slice(0, 4).map((s) => `<li><span>${esc(s.title ?? s.kind)}${s.source ? ` <a href="${esc(s.source)}" target="_blank" rel="noopener">source ↗</a>` : ''}</span></li>`).join('');
  const progressLabel = b.paid ? 'Released' : have === null ? 'Ships HEY counted' : `${have} of ${need} ships counted`;
  return `<article class="card bounty">
    <div class="top">
      <div class="id">${logo(project?.logoUrl, name)}<div><span class="name">${esc(name)}</span><a class="slug" href="${CONFIG.hey}/project/${encodeURIComponent(slug)}" target="_blank" rel="noopener">heyresearch.xyz/project/${esc(slug)}</a></div></div>
      <span class="chip ${state[0]}">${state[1]}</span>
    </div>
    <div class="facts">
      <div class="fact"><div class="k">Locked</div><div class="v">${fmt(b.total)} ${T.symbol}</div></div>
      <div class="fact"><div class="k">Ship by</div><div class="v">${day(b.deadline)}</div></div>
      <div class="fact"><div class="k">Burn on payout</div><div class="v">${(Number(b.burnBps) / 100).toFixed(1)}%</div></div>
      <div class="fact"><div class="k">Pays</div><div class="v"><a class="mono" href="${addrUrl(b.builder)}" target="_blank" rel="noopener">${short(b.builder)}</a></div></div>
    </div>
    <div class="progress">
      <div class="lbl"><span>${progressLabel}</span><span>${b.paid ? '' : `target ${need}`}</span></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${have ?? 0}"><i style="width:${pct}%"></i></div>
    </div>
    ${note ? `<p class="hint bad" style="margin:0">${note}</p>` : list ? `<ul class="ships">${list}</ul>` : b.paid ? '' : '<p class="hint" style="margin:0">No counted ships since the bounty opened yet.</p>'}
    <div class="actions">${actions.join('')}<span class="mono">#${id} · opened ${day(b.start)}${mine > 0n ? ` · you locked ${fmt(mine)} ${T.symbol}` : ''}</span></div>
  </article>`;
}

async function act(kind, id) {
  await needWallet();
  if (kind === 'fund') {
    const box = document.querySelector(`[data-fund-box="${id}"]`);
    if (box && box.hidden) { box.hidden = false; box.querySelector('input')?.focus(); return; }
    const v = box?.querySelector('input')?.value?.trim();
    if (!v || Number(v) <= 0) throw new Error(`Enter how much ${T.symbol} to add.`);
    const amount = parseUnits(v, T.decimals);
    const bal = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [account] });
    if (amount > bal) throw new Error(`You hold ${fmt(bal)} ${T.symbol}.`);
    await ensureAllowance(amount);
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'fund', args: [BigInt(id), amount] }, 'Add to bounty');
  } else if (kind === 'claim') {
    const b = await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bounty', args: [BigInt(id)] });
    const slug = await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'slugOf', args: [BigInt(id)] });
    toast('Asking HEY to sign the ship count…', true);
    // HEY signs only for a payout address the project verified to HEY; the escrow checks it equals the bounty's builder.
    const res = await heyAttestation(slug, b.builder, Number(b.start), Math.min(now() - 120, Number(b.deadline)));
    if (!res.ok) throw new Error(res.body.message ?? `HEY answered ${res.status}`);
    const a = res.body.attestation;
    const att = { project: a.project, builder: getAddress(a.builder), since: BigInt(a.since), until: BigInt(a.until), ships: Number(a.ships), evidence: a.evidence, issuedAt: BigInt(a.issuedAt) };
    if (att.builder !== getAddress(b.builder)) throw new Error('HEY does not attest this payout address for the project.');
    if (att.ships < Number(b.minShips)) throw new Error(`HEY counts ${att.ships} ships; the bounty needs ${b.minShips}.`);
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'claim', args: [BigInt(id), att, res.body.signature] }, 'Release');
  } else if (kind === 'refund') {
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'refund', args: [BigInt(id)] }, 'Take back');
  }
  toast('Done.');
  showBalance();
  await load();
}

// ------------------------------------------------------------------ contract facts
function renderContract() {
  if (!CONFIG.escrow) return;
  $('#contractFacts').innerHTML = [
    ['Escrow · source verified', CONFIG.escrow],
    ['$WIF', T.address],
    ['HEY attester', CONFIG.attester],
  ].filter(([, a]) => a).map(([k, a]) => `<div><div class="k">${k}</div><a href="${addrUrl(a)}" target="_blank" rel="noopener">${a}</a></div>`).join('');
}

function fail(err) { toast(esc(err?.shortMessage ?? err?.message ?? String(err))); }
$('#connect').addEventListener('click', () => connect().catch(fail));
$('#account').addEventListener('click', (e) => { e.stopPropagation(); $('#accountMenu').hidden = !$('#accountMenu').hidden; });
document.addEventListener('click', (e) => { if (!$('#accountMenu').hidden && !e.target.closest('#accountMenu')) $('#accountMenu').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#accountMenu').hidden = true; });
$('#acctCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(account); toast('Address copied.'); } catch { toast(account); } });
$('#acctDisconnect').addEventListener('click', () => disconnect().catch(fail));
$('#switchNet')?.addEventListener('click', () => ensureChain(true).catch(fail));
$('#walletsClose')?.addEventListener('click', () => $('#wallets').close());
renderPreview();
renderContract();
restoreWallet().catch(() => undefined).finally(() => { if (!account) load().catch(fail); });
