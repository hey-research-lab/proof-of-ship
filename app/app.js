import {
  createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, getAddress, isAddress, keccak256, recoverTypedDataAddress, stringToBytes,
} from './vendor/viem.js?v=9';
import { CONFIG } from './config.js?v=8';
import { badge, chainReady, emitStats, placeCard, removeCards, span } from './lib.js?v=1';

// A page that signs approve, fund and claim never runs inside another site's frame: it says so, links to itself and
// wires no action. GitHub Pages cannot send frame-ancestors, so the page checks for itself.
const framed = (() => { try { return window.top !== window.self; } catch { return true; } })();
if (framed) {
  const link = Object.assign(document.createElement('a'), { href: location.href, target: '_top', rel: 'noopener', textContent: 'Open it directly' });
  const note = Object.assign(document.createElement('p'), { textContent: 'Proof of Ship does not run inside another page. ' });
  note.style.cssText = 'padding:24px;font:16px/1.5 system-ui,sans-serif';
  note.append(link, '.');
  document.body.replaceChildren(note);
  throw new Error('Proof of Ship does not run inside a frame.');
}

const chain = {
  id: CONFIG.chainId, name: CONFIG.chainName,
  nativeCurrency: { name: 'Ether', symbol: CONFIG.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CONFIG.explorer } },
};
const pub = createPublicClient({ chain, transport: http(CONFIG.rpc) });
const ABI = await (await fetch('./ShipEscrow.abi.json?v=6')).json();
const ERC20 = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const GRACE = 3 * 86400;
const T = CONFIG.token;
const $ = (s) => document.querySelector(s);
let wallet = null, account = null;
/** The escrow's own `retired()`: null until read. Once the guardian retires it, refunds open at once and nothing else works. */
let escrowRetired = null;
/** One transaction flow at a time, page-wide: set before the first await, cleared in finally (see runExclusive). */
let busy = false;

// ------------------------------------------------------------------ helpers
let toastTimer;
/** A toast is plain text, or nodes built with the DOM: nothing from a wallet, HEY or an error message is parsed as HTML. */
const toast = (msg, sticky = false) => {
  clearTimeout(toastTimer);
  const el = $('#toast');
  if (msg instanceof Node) el.replaceChildren(msg); else el.textContent = msg || '';
  if (msg && !sticky) toastTimer = setTimeout(() => { el.replaceChildren(); }, 5000);
};
/** Text with one link in it, for a toast: `before`, a link to `href` reading `linkText`, then `after`. */
const linkToast = (before, href, linkText, after = '') => {
  const f = document.createDocumentFragment();
  const a = Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener', textContent: linkText });
  f.append(before, a, after);
  return f;
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
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** A transaction's explorer link, only for a well-formed hash: a wallet's answer is outside text. */
const tx = (h) => { if (!TX_HASH_RE.test(String(h))) throw new Error('The wallet answered with something that is not a transaction hash.'); return `${CONFIG.explorer}/tx/${h}`; };
const addrUrl = (a) => `${CONFIG.explorer}/address/${a}`;
/** A link or image address from HEY or the chain, only when it is https:; anything else is not rendered. */
const httpsUrl = (url) => { try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
/** The first letter or digit of a name, for a monogram where a project has no logo. */
const initial = (name) => (String(name ?? '').match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
const logo = (url, name) => httpsUrl(url)
  ? `<img src="${esc(httpsUrl(url))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-logo data-initial="${esc(initial(name))}">`
  : `<span class="ph" aria-hidden="true" title="${esc(name)}">${esc(initial(name))}</span>`;
/** A logo that fails to load becomes the monogram: a listener, since the page's CSP refuses inline handlers. */
function wireLogos(root) {
  root.querySelectorAll('img[data-logo]').forEach((img) => {
    const swap = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'ph', textContent: img.dataset.initial ?? '' }));
    if (img.complete && img.naturalWidth === 0) swap();
    else img.addEventListener('error', swap, { once: true });
  });
}
/** HEY slugs are lower-case letters, digits and hyphens; the escrow keys a bounty on keccak256 of the slug's exact bytes. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const isHeySlug = (slug) => SLUG_RE.test(slug);
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/** A bounty HEY can ever sign for: its slug is a HEY slug, and exactly the bytes the escrow hashed into `project`. */
const bountySlugOk = (slug, project) => isHeySlug(slug) && sameHash(keccak256(stringToBytes(slug)), project);
const SLUG_FORM_MESSAGE = 'Use the project’s HEY slug exactly as in heyresearch.xyz/project/slug: lower-case letters, digits and hyphens, no spaces. A bounty opened with any other slug can never be released.';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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
  if (!on) { $('#accountMenu').hidden = true; renderBanner(); return; }
  const icon = walletInfo?.icon ? `<img src="${esc(walletInfo.icon)}" alt="" width="18" height="18">` : '<span class="dot"></span>';
  $('#account').innerHTML = `${icon}<span>${short(account)}</span>${heldWif !== null ? `<span class="muted">${compact(heldWif)} ${T.symbol}</span>` : ''}`;
  $('#acctWallet').textContent = walletInfo?.name ?? 'Wallet';
  $('#acctAddr').textContent = account;
  $('#acctWif').textContent = heldWif !== null ? `${fmt(heldWif)} ${T.symbol}` : '…';
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
  toast(linkToast(`${label}: waiting for `, tx(hash), 'the transaction', '…'), true);
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

/**
 * Projects HEY's search matches for what the reader typed (typo-tolerant). Only project rows, each with its exact slug
 * read from its HEY path; anything else HEY suggests (a Stock Token, a launch record) is not a bounty target.
 */
async function heySuggest(q, signal) {
  const r = await fetch(`${CONFIG.hey}/api/search/suggest?q=${encodeURIComponent(q)}`, { signal });
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  const out = [];
  for (const s of Array.isArray(j.suggestions) ? j.suggestions : []) {
    if (s?.type !== 'project') continue;
    const slug = /^\/project\/([^/?#]+)$/.exec(String(s.target ?? ''))?.[1];
    if (!slug || !isHeySlug(slug) || out.some((x) => x.slug === slug)) continue;
    out.push({ slug, name: String(s.name || slug), status: typeof s.status === 'string' ? s.status : '', logoUrl: s.logoUrl ?? s.logo ?? null });
    if (out.length === 6) break;
  }
  return out;
}

/**
 * Which payout addresses HEY would sign for, from HEY's tie route. Anything but a 200 whose JSON carries `payable`
 * (the route not deployed yet, a network error, a 400 or 404) is `null`: the form then works as it always has, a
 * payout address typed by hand and checked against the attestation route.
 */
const tieCache = new Map();
const TIE_KINDS = ['token_deployer', 'wallet_claim'];
async function heyTie(slug) {
  if (tieCache.has(slug)) return tieCache.get(slug);
  let r;
  try { r = await fetch(`${CONFIG.hey}/api/v1/proof-of-ship/tie?slug=${encodeURIComponent(slug)}`); } catch { return null; }
  const j = r.ok ? await r.json().catch(() => null) : null;
  let tie = null;
  if (j && typeof j.payable === 'boolean') {
    const byAddr = new Map();
    for (const t of Array.isArray(j.ties) ? j.ties : []) {
      if (!TIE_KINDS.includes(t?.kind) || !isAddress(String(t?.address ?? ''))) continue;
      const address = getAddress(t.address);
      const seen = byAddr.get(address);
      if (seen) { if (!seen.kinds.includes(t.kind)) seen.kinds.push(t.kind); } else byAddr.set(address, { address, kinds: [t.kind] });
    }
    tie = {
      payable: j.payable, ties: j.payable ? [...byAddr.values()] : [],
      reason: typeof j.reason === 'string' ? j.reason : '', paused: j.attestationsPaused === true,
    };
  }
  // A busy HEY (5xx) is asked again next time; a definite answer, or a route that is not there, is kept for the visit.
  if (r.status < 500) tieCache.set(slug, tie);
  return tie;
}
const TIE_WORDS = { token_deployer: 'its token deployer', wallet_claim: 'the wallet that signed the project’s claim on HEY' };
const tieWords = (kinds) => kinds.map((k) => TIE_WORDS[k]).join(', and ');
/** HEY's reason a project can't be paid yet, in plain words; a code HEY adds later reads as a generic sentence. */
const TIE_REASONS = {
  // The codes HEY's tie route answers (GET /api/v1/proof-of-ship/tie, 2026-11-02), first failed condition first.
  no_token: 'it has no token HEY tracks, so no deployer or claim can be tied to it',
  token_not_verified: 'the project hasn’t confirmed the token HEY tracks as its own yet',
  issuer_token: 'its token is issued by Robinhood, not by the project',
  site_disclaims_contract: 'its own site says the token HEY tracks is not its own',
  site_names_another_contract: 'its own site names another contract than the token HEY tracks',
  contested: 'another page on HEY claims the same token',
  no_tie: 'HEY ties no wallet to it yet: the deployer is a shared launch service or not read, and no wallet has signed a claim for it',
};
const tieReason = (code) => TIE_REASONS[code]
  ?? (/\s/.test(code) ? code.replace(/[.\s]+$/, '') : 'HEY ties no wallet to it yet');

// ------------------------------------------------------------------ composer
const form = $('#create');
/** A plain decimal amount, no sign or exponent, at most the token's 18 decimals: "5000", "12.5". */
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
const AMOUNT_MESSAGE = `Enter the ${T.symbol} as a plain number above 0, e.g. 5000.`;
/** The amount in token units, or null when the text is not a plain decimal above 0. */
const parseAmount = (text) => {
  const t = String(text ?? '').trim();
  if (!AMOUNT_RE.test(t)) return null;
  try { const v = parseUnits(t, T.decimals); return v > 0n ? v : null; } catch { return null; }
};
function readForm() {
  const f = new FormData(form);
  const amountStr = String(f.get('amount') ?? '').trim();
  const parsed = parseAmount(amountStr);
  const amount = parsed ?? 0n;
  return {
    // As typed (less surrounding spaces), never tidied: the escrow keys the bounty on these exact bytes.
    slug: String(f.get('slug') || '').trim(),
    builder: String(f.get('builder') || '').trim(),
    minShips: Math.max(0, Math.floor(Number(f.get('minShips')) || 0)),
    days: Math.max(0, Math.floor(Number(f.get('days')) || 0)),
    burnBps: Math.round(Math.min(10, Math.max(0, Number(f.get('burn')) || 0)) * 100),
    amount,
    amountOk: parsed !== null,
  };
}
function renderPreview() {
  const v = readForm();
  const burned = (v.amount * BigInt(v.burnBps)) / 10_000n;
  $('#pAmt').innerHTML = `${fmt(v.amount)}<small>${T.symbol}</small>`;
  $('#pPay').textContent = `${fmt(v.amount - burned)} ${T.symbol}`;
  $('#pBurn').textContent = `${fmt(burned)} ${T.symbol}`;
  $('#pShips').textContent = `${v.minShips || '…'} ship${v.minShips === 1 ? '' : 's'}`;
  const by = now() + v.days * 86400;
  $('#pBy').textContent = v.days ? day(by) : '…';
  $('#pRefund').textContent = v.days ? day(by + GRACE) : '…';
  $('#daysHint').textContent = v.days ? `Ships counted until ${day(by)}.` : '';
  const bh = $('#balHint'), btn = $('#openBtn');
  let over = false;
  if (!v.amountOk) {
    bh.className = 'hint bad';
    bh.textContent = AMOUNT_MESSAGE;
  } else if (heldWif !== null) {
    over = v.amount > heldWif;
    bh.className = over ? 'hint bad' : 'hint';
    bh.innerHTML = `${over ? 'More than you hold: ' : 'You hold '}${fmt(heldWif)} ${T.symbol}. <a href="#" id="useAll">Use all</a>`;
  } else if (bh.classList.contains('bad') && bh.textContent === AMOUNT_MESSAGE) {
    bh.className = 'hint'; bh.textContent = '';
  }
  btn.disabled = over || busy || escrowRetired === true;
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
  if (slug !== tieState.slug) setTie(null, null);
  if (!slug) { hint.innerHTML = 'The slug in heyresearch.xyz/project/<span class="mono">slug</span>'; card.className = 'project'; renderPreview(); return; }
  if (!isHeySlug(slug)) { hint.className = 'hint bad'; hint.textContent = SLUG_FORM_MESSAGE; card.className = 'project'; renderPreview(); return; }
  const p = await heyProject(slug).catch(() => undefined);
  if (readForm().slug !== slug) return;
  if (p === null) { hint.className = 'hint bad'; hint.textContent = 'Not a published project on HEY.'; card.className = 'project'; }
  else if (p) {
    hint.className = 'hint ok'; hint.textContent = 'Found on HEY.';
    const last = p.lastShippedAt ? `last shipped ${day(Date.parse(p.lastShippedAt) / 1000)}` : 'no ship read yet';
    card.innerHTML = `${logo(p.logoUrl, p.name)}<div><b>${esc(p.name)}</b><span>${esc(String(p.activityStatus ?? '').toLowerCase().replace('_', ' '))} · ${last}</span></div>`;
    wireLogos(card);
    card.className = 'project on';
    heyTie(slug).then((t) => { if (readForm().slug === slug) setTie(slug, t); }).catch(() => undefined);
  }
  renderPreview();
  checkBuilder();
}, 350);

/*
 * The payout tie HEY reports for the project in the field. With exactly one address it fills the payout field (only
 * when the reader hasn't typed one); with two it offers both; with none it says plainly what a bounty opened now can
 * and can't do. The attestation check on the payout field and on Open stays the gate either way.
 */
let tieState = { slug: null, tie: null };
/** The last signature check of the payout field: the tie box says "HEY will pay" only once HEY's signature checked out. */
let tieCheck = { slug: null, builder: null, ok: null };
const tieChecked = (slug, address) => tieCheck.slug === slug && isAddress(String(tieCheck.builder)) && sameHash(tieCheck.builder, address) ? tieCheck.ok : null;
let autofilled = null; // the payout address this page wrote, so a later project may replace it and a typed one never is
function writeBuilder(address) {
  const el = $('#builder');
  el.value = address;
  autofilled = address;
  checkBuilder();
  renderPreview();
}
function setTie(slug, tie) {
  tieState = { slug, tie };
  const el = $('#builder');
  const mine = el.value.trim() === '' || el.value === autofilled;
  if (tie && mine) {
    if (tie.ties.length === 1) { if (el.value !== tie.ties[0].address) writeBuilder(tie.ties[0].address); }
    else if (autofilled && el.value === autofilled && !tie.ties.some((t) => t.address === autofilled)) writeBuilder('');
  } else if (!tie && slug === null && autofilled && el.value === autofilled) {
    writeBuilder('');
  }
  renderTie();
}
/** The full payout address, linked to the explorer, so the reader can check every character before signing. */
const addrLine = (address) => `<p class="addr-line">Payout address <a class="mono" href="${esc(addrUrl(address))}" target="_blank" rel="noopener">${esc(address)} ↗</a></p>`;
function renderTie() {
  const box = $('#tieBox');
  const { tie } = tieState;
  if (!tie) { box.innerHTML = ''; return; }
  const typed = readForm().builder;
  const parts = [];
  if (tie.paused) parts.push('<p class="note">HEY has paused signing for now. No bounty can be released until it resumes; refunds after the deadline don’t need HEY.</p>');
  if (!tie.payable || !tie.ties.length) {
    parts.push(`<p class="bad">HEY can’t pay this project yet: ${esc(tieReason(tie.reason))}. A bounty you open now can only be refunded after its deadline.</p>`);
  } else if (tie.ties.length === 1) {
    const t = tie.ties[0];
    const checked = tieChecked(tieState.slug, t.address);
    parts.push(checked === true
      ? `<p class="ok">HEY will pay this address: ${esc(tieWords(t.kinds))}.</p>${addrLine(t.address)}`
      : `<p>HEY names this address, ${esc(tieWords(t.kinds))}${checked === false ? ', but HEY did not confirm it just now: see the note under the payout address.' : '. Checking HEY’s signature for it…'}</p>${addrLine(t.address)}`);
  } else {
    parts.push('<p>HEY ties two addresses to this project. Choose the one to pay:</p>');
    parts.push(`<div class="choices">${tie.ties.map((t) => `<button type="button" data-tie="${esc(t.address)}" aria-pressed="${Boolean(typed) && sameHash(typed, t.address)}"><span>${esc(tieWords(t.kinds).replace(/^./, (c) => c.toUpperCase()))}</span><span class="mono">${esc(t.address)}</span></button>`).join('')}</div>`);
    const chosen = tie.ties.find((t) => isAddress(typed) && sameHash(t.address, typed));
    if (chosen) parts.push(addrLine(chosen.address));
  }
  if (tie.payable && tie.ties.length && isAddress(typed) && !tie.ties.some((t) => sameHash(t.address, typed))) {
    parts.push(`<p class="bad">HEY will not sign for ${esc(short(typed))}: it isn’t an address HEY ties to this project.</p>`);
  }
  box.innerHTML = parts.join('');
  box.querySelectorAll('[data-tie]').forEach((b) => b.addEventListener('click', () => { writeBuilder(b.dataset.tie); renderTie(); }));
}
const checkBuilder = debounce(async () => {
  const { slug, builder } = readForm();
  const hint = $('#builderHint');
  hint.className = 'hint';
  if (!builder) { hint.textContent = "A wallet HEY ties to the project. It can't be changed later."; renderPreview(); return; }
  if (!isAddress(builder)) { hint.className = 'hint bad'; hint.textContent = 'Not a valid address.'; renderPreview(); return; }
  renderPreview();
  if (!slug || !isHeySlug(slug) || !CONFIG.escrow) return;
  const tie = await builderTie(slug, builder);
  // An answer for an address or project the field no longer holds is dropped, never shown beside the new one.
  const cur = readForm();
  if (cur.slug !== slug || cur.builder !== builder) return;
  tieCheck = { slug, builder, ok: tie.ok };
  renderTie();
  if (tie.ok) { hint.className = 'hint ok'; hint.textContent = tie.text; }
  else if (tie.known) { hint.className = 'hint bad'; hint.textContent = tie.text; }
}, 450);
/** The EIP-712 domain and type the escrow checks HEY's signature against (src/ShipEscrow.sol, SHIPS_TYPEHASH). */
const SHIPS_TYPES = {
  Ships: [
    { name: 'project', type: 'bytes32' }, { name: 'builder', type: 'address' }, { name: 'since', type: 'uint64' },
    { name: 'until', type: 'uint64' }, { name: 'ships', type: 'uint32' }, { name: 'evidence', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
};
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
/**
 * Whether an attestation answer is HEY's signature over this exact project and payout address: the project is
 * keccak256 of the slug's exact bytes, the builder is the address asked about, and the EIP-712 signer is the attester
 * fixed in the escrow. A 200 that is anything else proves nothing, whatever it says.
 */
async function attestationSignedFor(body, slug, builder) {
  const a = body?.attestation;
  if (!a || typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return false;
  if (!isAddress(String(a.builder ?? '')) || !sameHash(a.builder, builder)) return false;
  if (!sameHash(a.project, keccak256(stringToBytes(slug))) || !BYTES32_RE.test(String(a.evidence ?? ''))) return false;
  try {
    const message = {
      project: a.project, builder: getAddress(a.builder), since: BigInt(a.since), until: BigInt(a.until),
      ships: Number(a.ships), evidence: a.evidence, issuedAt: BigInt(a.issuedAt),
    };
    const signer = await recoverTypedDataAddress({
      domain: { name: 'HEY Proof of Ship', version: '1', chainId: CONFIG.chainId, verifyingContract: CONFIG.escrow },
      types: SHIPS_TYPES, primaryType: 'Ships', message, signature: body.signature,
    });
    return sameHash(signer, CONFIG.attester);
  } catch { return false; }
}
/**
 * Whether HEY ties a payout address to the project — asked of HEY's attestation route over a one-minute window, so
 * nothing is signed that could be used, and the signature checked against the escrow's attester before it counts.
 * `known` is false when HEY could not be asked (offline, busy, paused).
 */
async function builderTie(slug, builder) {
  const t = now() - 120;
  const res = await heyAttestation(slug, builder, t - 60, t).catch(() => null);
  if (res?.ok) {
    if (!(await attestationSignedFor(res.body, slug, builder))) {
      return { ok: false, known: true, text: 'HEY’s answer for this address is not HEY’s signature for this project and address, so the page will not open a bounty for it.' };
    }
    const how = res.body.builderTie === 'wallet_claim' ? 'it signed for the project’s token to claim the project on HEY' : 'it deployed the project’s verified token';
    return { ok: true, known: true, text: `HEY ties this address to the project: ${how}.` };
  }
  if (res?.status === 403) {
    return { ok: false, known: true, text: `HEY doesn’t tie this address to the project, so it would never sign a payout to it. ${res.body?.message ?? ''}`.trim() };
  }
  if (res?.status === 400 || res?.status === 404) return { ok: false, known: true, text: res.body?.message ?? 'HEY refused this project.' };
  return { ok: false, known: false, text: 'HEY couldn’t check this payout address just now; try again shortly.' };
}
form.addEventListener('click', (e) => {
  if (e.target.id !== 'useAll' || heldWif === null) return;
  e.preventDefault();
  $('#amount').value = formatUnits(heldWif, T.decimals);
  renderPreview();
});
form.addEventListener('input', (e) => {
  if (e.target.name === 'slug') checkSlug();
  else if (e.target.name === 'builder') { checkBuilder(); renderTie(); }
  renderPreview();
});

// ------------------------------------------------------------------ time to ship: 7 / 14 / 30 days or custom
// The presets only write the `days` field; readForm and the 1–365 checks read it exactly as before.
const daysInput = $('#days');
const presetButtons = [...document.querySelectorAll('#daysPresets [data-days]')];
function pressPreset(which) { presetButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.days === which))); }
presetButtons.forEach((b) => b.addEventListener('click', () => {
  const custom = b.dataset.days === 'custom';
  pressPreset(b.dataset.days);
  $('#daysCustom').hidden = !custom;
  if (custom) { daysInput.focus(); daysInput.select(); } else daysInput.value = b.dataset.days;
  renderPreview();
}));
// A value the browser restored into the field (back/forward) picks its preset, or shows the custom box.
{
  const v = String(Math.floor(Number(daysInput.value) || 0));
  const match = presetButtons.find((b) => b.dataset.days === v);
  pressPreset(match ? v : 'custom');
  $('#daysCustom').hidden = Boolean(match);
}

// ------------------------------------------------------------------ project autocomplete (ARIA combobox)
/*
 * Suggestions come from HEY's public search. Picking one writes its exact HEY slug; what the reader types by hand is
 * never rewritten, because the escrow keys a bounty on those exact bytes.
 */
const slugInput = $('#slug');
const slugList = $('#slugList');
let acItems = [], acActive = -1, acAbort = null, acSeq = 0;
let acDismissed = null; // the text the reader closed the list on (Escape or a pick): a search still pending for it stays closed
function acClose() {
  slugList.hidden = true;
  slugList.innerHTML = '';
  acItems = []; acActive = -1;
  slugInput.setAttribute('aria-expanded', 'false');
  slugInput.removeAttribute('aria-activedescendant');
}
const payChip = (slug) => {
  if (!tieCache.has(slug) || !tieCache.get(slug)) return ['', ''];
  return tieCache.get(slug).payable ? ['ok', 'can be paid'] : ['no', 'not payable yet'];
};
function acRender() {
  slugList.innerHTML = acItems.map((it, i) => {
    const [cls, word] = payChip(it.slug);
    return `<li role="option" id="slugOpt${i}" data-i="${i}" aria-selected="${i === acActive}">${logo(it.logoUrl, it.name)}<span class="txt"><span class="nm"><b>${esc(it.name)}</b><span class="pay ${cls}">${word}</span></span><span class="sl">${esc(it.slug)}</span>${it.status ? `<span class="st">${esc(it.status)}</span>` : ''}</span></li>`;
  }).join('');
  wireLogos(slugList);
  slugList.hidden = !acItems.length;
  slugInput.setAttribute('aria-expanded', String(acItems.length > 0));
  if (acActive >= 0) slugInput.setAttribute('aria-activedescendant', `slugOpt${acActive}`); else slugInput.removeAttribute('aria-activedescendant');
}
// The "can be paid" chip is asked of HEY only for the highlighted project, once per slug, and never holds up typing.
const acChip = debounce(async (slug) => {
  if (tieCache.has(slug)) return;
  await heyTie(slug).catch(() => null);
  const i = acItems.findIndex((it) => it.slug === slug);
  const li = i >= 0 ? slugList.querySelector(`[data-i="${i}"] .pay`) : null;
  if (li) { const [cls, word] = payChip(slug); li.className = `pay ${cls}`; li.textContent = word; }
}, 150);
function acHighlight(i) {
  acActive = i;
  slugList.querySelectorAll('[role="option"]').forEach((li) => li.setAttribute('aria-selected', String(Number(li.dataset.i) === i)));
  if (i >= 0) {
    slugInput.setAttribute('aria-activedescendant', `slugOpt${i}`);
    slugList.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    acChip(acItems[i].slug);
  } else slugInput.removeAttribute('aria-activedescendant');
}
function acPick(i) {
  const it = acItems[i];
  if (!it) return;
  slugInput.value = it.slug;
  acDismissed = it.slug;
  acClose();
  checkSlug();
  renderPreview();
}
const acSearch = debounce(async () => {
  const q = slugInput.value.trim();
  const seq = ++acSeq;
  acAbort?.abort();
  if (q.length < 2 || document.activeElement !== slugInput || slugInput.value === acDismissed) { acClose(); return; }
  acAbort = new AbortController();
  const items = await heySuggest(q, acAbort.signal).catch(() => null);
  if (seq !== acSeq || items === null || document.activeElement !== slugInput || slugInput.value === acDismissed) return;
  acItems = items; acActive = -1;
  acRender();
}, 200);
slugInput.addEventListener('input', acSearch);
slugInput.addEventListener('keydown', (e) => {
  if (slugList.hidden) {
    if (e.key === 'Escape') acDismissed = slugInput.value;
    else if (e.key === 'ArrowDown' && slugInput.value.trim().length >= 2) { e.preventDefault(); acDismissed = null; acSearch(); }
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); acHighlight((acActive + 1) % acItems.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); acHighlight(acActive <= 0 ? acItems.length - 1 : acActive - 1); }
  else if (e.key === 'Enter' && acActive >= 0) { e.preventDefault(); acPick(acActive); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acDismissed = slugInput.value; acClose(); }
  else if (e.key === 'Tab') acClose();
});
slugInput.addEventListener('blur', () => { acSeq++; acAbort?.abort(); acClose(); });
// mousedown keeps the focus in the field, so the blur above doesn't close the list before the click lands.
slugList.addEventListener('mousedown', (e) => e.preventDefault());
slugList.addEventListener('click', (e) => { const li = e.target.closest('[role="option"]'); if (li) acPick(Number(li.dataset.i)); });
slugList.addEventListener('mousemove', (e) => { const li = e.target.closest('[role="option"]'); if (li && Number(li.dataset.i) !== acActive) acHighlight(Number(li.dataset.i)); });

/*
 * One transaction flow at a time. The flag is checked and set before the first await, so a double click, or Open
 * pressed while an Add is pending, starts nothing; every action button is disabled and the form is inert until the flow
 * ends, so what the screen shows cannot drift from what the wallet is asked to sign.
 */
function setBusy(on) {
  busy = on;
  form.inert = on || escrowRetired === true;
  document.querySelectorAll('[data-act], .fund-box input').forEach((el) => { el.disabled = on; });
  renderPreview();
}
let focusAfter = null; // a field a refusal pointed at, focused once the form is no longer inert
async function runExclusive(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); } finally {
    setBusy(false);
    if (focusAfter) { $(focusAfter)?.focus({ preventScroll: true }); focusAfter = null; }
  }
}

/** Whether the escrow is retired, read from the chain now; a failed read is an error, never "not retired". */
async function readRetired() {
  const r = await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'retired' });
  if (r !== escrowRetired) { escrowRetired = r; renderRetired(); }
  return r;
}
const RETIRED_MESSAGE = 'This escrow was retired by its guardian. Backers can take their $WIF back now.';
/** A retired escrow: say so at the top, and take away Open (the cards drop Add and Release and offer Take back). */
function renderRetired() {
  const on = escrowRetired === true;
  $('#retiredBanner').hidden = !on;
  $('#retiredNote').hidden = !on;
  $('#openBtn').hidden = on;
  form.inert = on || busy;
  renderPreview();
  renderBanner();
}

/** A deadline the escrow accepts when the create is mined: from the chain's latest block, never the reader's clock. */
const MIN_DURATION = 86400, MAX_DURATION = 365 * 86400; // src/ShipEscrow.sol
const DEADLINE_MARGIN = 15 * 60;
async function chainDeadline(days) {
  const block = await pub.getBlock({ blockTag: 'latest' });
  const base = Number(block.timestamp);
  // MIN_DURATION and MAX_DURATION are measured from the block the create lands in, which is at or after `base`: the
  // margin keeps a 1-day bounty valid while the reader confirms, and the cap keeps a 365-day one inside the maximum.
  const want = base + days * 86400 + DEADLINE_MARGIN;
  return BigInt(Math.min(Math.max(want, base + MIN_DURATION + DEADLINE_MARGIN), base + MAX_DURATION));
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  runExclusive(openBounty).catch(fail);
});
async function openBounty() {
  try {
    if (!CONFIG.escrow) throw new Error('The escrow is not deployed yet.');
    const v = readForm();
    const bad = (id, hintId, msg) => { const h = $(hintId); h.className = 'hint bad'; h.textContent = msg; focusAfter = id; $(id).scrollIntoView({ behavior: 'smooth', block: 'center' }); return new Error(msg); };
    if (!v.slug) throw bad('#slug', '#slugHint', 'Type the project’s slug, e.g. predict-fwa.');
    // Refused, not warned: the escrow keys a bounty on these bytes for good, and HEY signs only a HEY slug.
    if (!isHeySlug(v.slug)) throw bad('#slug', '#slugHint', SLUG_FORM_MESSAGE);
    if (!isAddress(v.builder)) throw bad('#builder', '#builderHint', 'Paste the builder’s payout address (0x…).');
    if (v.minShips < 1) throw new Error('A bounty needs at least one ship.');
    if (v.days < 1 || v.days > 365) throw new Error('Time to ship is 1 to 365 days.');
    // Refused, not warned: an empty bounty is hidden from the list and helps nobody.
    if (!v.amountOk) throw bad('#amount', '#balHint', AMOUNT_MESSAGE);
    if (await readRetired()) throw new Error(RETIRED_MESSAGE);
    const project = await heyProject(v.slug);
    if (!project) throw new Error(`HEY has no published project "${v.slug}".`);
    // Refused, not warned: a bounty for an address HEY will never sign for locks its $WIF until the deadline passes.
    const tie = await builderTie(v.slug, v.builder);
    if (!tie.ok) throw bad('#builder', '#builderHint', tie.text);
    await needWallet();
    const bal = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [account] });
    if (v.amount > bal) throw new Error(`You hold ${fmt(bal)} ${T.symbol}; lower the amount to lock.`);
    await ensureAllowance(v.amount);
    const deadline = await chainDeadline(v.days);
    const builder = getAddress(v.builder);
    const hash = await send({ address: CONFIG.escrow, abi: ABI, functionName: 'create', args: [T.address, builder, v.slug, v.minShips, deadline, v.burnBps, v.amount] }, `Open bounty for ${v.slug} paying ${builder}`);
    toast(linkToast('Bounty opened. ', tx(hash), 'View transaction'));
    await load();
    document.getElementById('bounties-section').scrollIntoView({ behavior: 'smooth' });
  } catch (err) { fail(err); }
}

// ------------------------------------------------------------------ bounties
/*
 * The list reads the chain newest first, a page at a time, and shows only funded bounties: an empty bounty costs a
 * cent to open, so the page never reads or asks HEY about every one. HEY is asked about a bounty only when its card
 * scrolls into view.
 */
const PAGE = 20;        // funded bounties shown per page
const SCAN = 100;       // bounty ids read from the chain per page at most
const CHUNK = 10;       // ids read at once
let listing = null;

/** The list from the chain; a read that fails says so in the list instead of leaving it waiting. */
async function load() {
  try { await readList(); } catch (err) { emitStats('robinhood', { failed: true }); chainReady('robinhood', 'The Robinhood Chain escrow could not be read just now.'); throw err; }
}
async function readList() {
  if (!CONFIG.escrow) { chainReady('robinhood', 'The Robinhood Chain escrow is being deployed.'); return; }
  const [count, locked, retired] = await Promise.all([
    pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bountyCount' }).then(Number),
    pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [CONFIG.escrow] }),
    pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'retired' }),
  ]);
  if (retired !== escrowRetired) { escrowRetired = retired; renderRetired(); }
  $('#sLocked').innerHTML = `${compact(locked)}<small>${T.symbol}</small>`;
  lockedNow = locked;
  if (count === 0) {
    removeCards('robinhood');
    $('#rhMore').replaceChildren();
    $('#sOpen').textContent = '0'; $('#sPaid').innerHTML = `0<small>${T.symbol}</small>`; $('#sBurned').innerHTML = `0<small>${T.symbol}</small>`;
    $('#bCount').textContent = '';
    emitStats('robinhood', { count: 0, open: 0, locked, paid: 0n, burned: 0n, builders: [], decimals: T.decimals });
    chainReady('robinhood');
    return;
  }
  listing?.observer?.disconnect();
  listing = { count, next: count - 1, shown: 0, unfunded: 0, paid: 0n, burned: 0n, open: 0, builders: new Set(), observer: null, rows: [], atts: new Map() };
  removeCards('robinhood');
  await more();
  // A #bounty-<id> link scrolls to its card once per visit; a later reload of the list (after an action) does not.
  if (!deepLinked && hashBounty() !== null) { deepLinked = true; goToBounty(hashBounty()).catch(() => undefined); }
}

let lockedNow = null;
async function more() {
  const l = listing;
  $('#rhMore').replaceChildren();
  const funded = [];
  let read = 0;
  while (l.next >= 0 && funded.length < PAGE && read < SCAN) {
    const ids = [];
    while (ids.length < CHUNK && l.next >= 0 && read < SCAN) { ids.push(l.next--); read++; }
    const bounties = await Promise.all(ids.map((id) => pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bounty', args: [BigInt(id)] })));
    ids.forEach((id, i) => {
      const b = bounties[i];
      if (b.paid) { const x = (b.total * BigInt(b.burnBps)) / 10_000n; l.burned += x; l.paid += b.total - x; l.builders.add(b.builder.toLowerCase()); }
      else if (b.total > 0n && !escrowRetired && now() <= Number(b.deadline) + GRACE) l.open++;
      if (b.total === 0n) l.unfunded++;
      else funded.push({ id, b });
    });
  }
  const slugs = await Promise.all(funded.map(({ id }) => pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'slugOf', args: [BigInt(id)] })));
  const rows = funded.map((row, i) => ({ ...row, slug: slugs[i] }));
  l.shown += rows.length;
  l.rows.push(...rows);

  // The totals are over every bounty only once every bounty has been read.
  const all = l.next < 0;
  $('#sOpen').textContent = all ? String(l.open) : '…';
  $('#sPaid').innerHTML = all ? `${compact(l.paid)}<small>${T.symbol}</small>` : '…';
  $('#sBurned').innerHTML = all ? `${compact(l.burned)}<small>${T.symbol}</small>` : '…';
  $('#bCount').textContent = `${l.count} on Robinhood Chain${l.unfunded ? ` (${l.unfunded} with nothing locked not shown)` : ''}`;
  if (all) emitStats('robinhood', { count: l.count, open: l.open, locked: lockedNow, paid: l.paid, burned: l.burned, builders: [...l.builders], decimals: T.decimals });

  if (!l.observer && 'IntersectionObserver' in window) {
    l.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        l.observer.unobserve(entry.target);
        hydrate(entry.target).catch(() => undefined);
      }
    }, { rootMargin: '200px 0px' });
  }
  for (const row of rows) {
    const holder = document.createElement('div');
    holder.innerHTML = renderBounty(row, { pending: true });
    const card = holder.firstElementChild;
    card.__row = row;
    placeCard(card);
    wireCard(card);
    if (l.observer) l.observer.observe(card); else hydrate(card).catch(() => undefined);
  }
  if (l.next >= 0) {
    const btn = Object.assign(document.createElement('button'), { className: 'more', textContent: 'Show more Robinhood Chain bounties' });
    btn.addEventListener('click', () => { btn.disabled = true; more().catch(fail); });
    $('#rhMore').append(btn);
  }
  chainReady('robinhood');
  renderBanner();
}

function wireCard(card) {
  card.querySelectorAll('[data-act]').forEach((el) => {
    el.disabled = busy;
    el.addEventListener('click', () => runExclusive(() => act(el.dataset.act, Number(el.dataset.id))).catch(fail));
  });
  card.querySelectorAll('[data-copy-link]').forEach((el) => el.addEventListener('click', () => copyLink(el)));
  wireLogos(card);
}

/** Copy a bounty's link; where the clipboard is refused, show the link selected so the reader can copy it. */
async function copyLink(btn) {
  const url = bountyUrl(Number(btn.dataset.copyLink));
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.');
  } catch {
    const box = btn.parentElement.querySelector('.linkbox');
    if (!box) { toast(url); return; }
    box.hidden = false;
    box.value = url;
    box.focus();
    box.select();
    toast('Select and copy the link.');
  }
}

/** HEY's signed count for one bounty, asked once per read of the list (the card and the builder banner share it). */
function attFor({ id, b, slug }) {
  const until = Math.min(now() - 120, Number(b.deadline));
  if (escrowRetired || !bountySlugOk(slug, b.project) || b.paid || until < Number(b.start)) return Promise.resolve(null);
  const cache = listing?.atts;
  if (cache?.has(id)) return cache.get(id);
  const p = heyAttestation(slug, b.builder, Number(b.start), until).catch(() => null);
  cache?.set(id, p);
  return p;
}
/** The ships HEY signed for, only when the answer is for this bounty's project; otherwise null (not read, never 0). */
const signedShips = (att, b) => (att?.ok && sameHash(att.body.attestation?.project, b.project) ? Number(att.body.attestation.ships) : null);

// ------------------------------------------------------------------ deep links (#bounty-<id>)
let deepLinked = false;
const hashBounty = () => { const m = /^#bounty-(\d{1,9})$/.exec(location.hash); return m ? Number(m[1]) : null; };
/** Scroll to a bounty's card and mark it for a moment; reads further pages of the list (a few at most) to find it. */
async function goToBounty(id, { release = false } = {}) {
  let card = document.getElementById(`bounty-${id}`);
  for (let i = 0; !card && listing && listing.next >= 0 && i < 5; i++) { await more(); card = document.getElementById(`bounty-${id}`); }
  if (!card) return false;
  if (card.dataset.pending) {
    listing?.observer?.unobserve(card);
    await hydrate(card).catch(() => undefined);
    card = document.getElementById(`bounty-${id}`) ?? card;
  }
  card.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  card.classList.add('hl');
  setTimeout(() => document.getElementById(`bounty-${id}`)?.classList.remove('hl'), 2400);
  if (release) card.querySelector('[data-act="claim"]')?.focus({ preventScroll: true });
  return true;
}
window.addEventListener('hashchange', () => { const id = hashBounty(); if (id !== null) goToBounty(id).catch(() => undefined); });

// ------------------------------------------------------------------ builder banner
/*
 * When the connected wallet is the payout address of an open bounty, say so at the top: what it pays, HEY's signed
 * count of the target, and the deadline. A bounty whose target is met says it can be released now and points at the
 * Release button. Read only: nothing here signs or sends.
 */
let bannerSeq = 0;
async function renderBanner() {
  const el = $('#builderBanner');
  const seq = ++bannerSeq;
  const mineRows = account && listing && !escrowRetired
    ? listing.rows.filter(({ b, slug }) => !b.paid && b.total > 0n && now() <= Number(b.deadline) + GRACE && sameHash(b.builder, account) && bountySlugOk(slug, b.project))
    : [];
  if (!mineRows.length) { el.hidden = true; el.innerHTML = ''; return; }
  const items = (await Promise.all(mineRows.map(async (row) => {
    const [project, att] = await Promise.all([heyProject(row.slug).catch(() => null), attFor(row)]);
    if (att && !att.ok && (att.status === 403 || att.status === 404)) return null; // HEY will never sign it: no claim to make
    const have = signedShips(att, row.b);
    const met = have !== null && have >= Number(row.b.minShips);
    if (!met && now() > Number(row.b.deadline)) return null; // past the deadline unmet: it can no longer be released
    return { row, name: project?.name ?? row.slug, have, met };
  }))).filter(Boolean);
  if (seq !== bannerSeq) return;
  if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
  const lines = items.map(({ row: { id, b }, name, have, met }) => {
    const need = Number(b.minShips);
    const count = have === null ? `ship count not read yet · target ${need}` : `${have} of ${need} ships counted`;
    const facts = `${fmt(b.total)} ${T.symbol} for ${esc(name)} · ${count} · ship by ${day(b.deadline)}`;
    const ready = met ? '<p class="ok">Target met: it can be released now with <b>Release to builder</b> on the bounty. Anyone can press it, and the $WIF goes to your wallet.</p>' : '';
    return `<div class="banner-row"><div><p>${facts}</p>${ready}</div><a class="${met ? 'go-link' : 'share'}" href="#bounty-${id}" data-goto="${id}"${met ? ' data-release="1"' : ''}>${met ? `Go to Release on #${id}` : `See bounty #${id}`}</a></div>`;
  });
  el.innerHTML = `<h2>${items.length === 1 ? 'A bounty is waiting for your ships' : `${items.length} bounties are waiting for your ships`}</h2>${lines.join('')}`;
  el.hidden = false;
  el.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', `#bounty-${a.dataset.goto}`);
    goToBounty(Number(a.dataset.goto), { release: a.dataset.release === '1' }).catch(() => undefined);
  }));
}

/** Ask HEY about one bounty (its project, its signed count and the ships behind it) and redraw its card. */
async function hydrate(card) {
  const row = card.__row;
  const { id, b, slug } = row;
  const slugOk = bountySlugOk(slug, b.project);
  const [project, mine, att] = await Promise.all([
    slugOk ? heyProject(slug).catch(() => null) : null,
    account ? pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'contributed', args: [BigInt(id), account] }).catch(() => 0n) : 0n,
    attFor(row),
  ]);
  const ships = att?.ok ? await shipTitles(slug, att.body.evidenceIds ?? []).catch(() => []) : [];
  const holder = document.createElement('div');
  holder.innerHTML = renderBounty(row, { project, mine, att, ships });
  const next = holder.firstElementChild;
  next.__row = row;
  if (card.classList.contains('hl')) next.classList.add('hl');
  card.replaceWith(next);
  wireCard(next);
}

const KIND = {
  release: 'Release', code: 'Code week', contract_deploy: 'Contract deployed', contract_upgrade: 'Contract upgrade',
  build: 'Build', integration: 'Integration', announcement: 'Entry', contract_source: 'Contract source',
};
const shortId = (evidenceId) => `${String(evidenceId).slice(0, 13)}…`;

/** Which ships HEY counted (five at most), each with its kind, title, the day HEY first recorded it and its evidence page. */
const SHIPS_SHOWN = 5;
function countedShips(att, ships) {
  const ids = att.body.evidenceIds ?? [];
  const urls = att.body.evidenceUrls ?? [];
  if (!ids.length) return '';
  const byId = new Map(ships.map((s) => [s.id, s]));
  const items = ids.slice(0, SHIPS_SHOWN).map((evidenceId, i) => {
    const s = byId.get(evidenceId);
    const evidence = httpsUrl(urls[i]);
    const source = httpsUrl(s?.source);
    const recorded = Date.parse(s?.recordedAt ?? '');
    const when = Number.isFinite(recorded) ? `recorded ${esc(day(recorded / 1000))}` : 'recorded date not read';
    const what = s ? `<b>${esc(KIND[s.kind] ?? s.kind ?? 'Ship')}</b> · ${esc(s.title ?? '')} · <span class="muted">${when}</span>` : `<b>Counted ship</b> · <span class="mono">${esc(shortId(evidenceId))}</span>`;
    return `<li><span>${what}${evidence ? ` <a href="${esc(evidence)}" target="_blank" rel="noopener">evidence ↗</a>` : ''}${source ? ` <a href="${esc(source)}" target="_blank" rel="noopener">source ↗</a>` : ''}</span></li>`;
  });
  const rest = ids.length > SHIPS_SHOWN ? `<li><span>and ${ids.length - SHIPS_SHOWN} more</span></li>` : '';
  return `<ul class="ships">${items.join('')}${rest}</ul>`;
}

function renderBounty({ id, b, slug }, hey) {
  const { project = null, mine = 0n, att = null, ships = [], pending = false } = hey;
  const slugOk = bountySlugOk(slug, b.project);
  const until = Math.min(now() - 120, Number(b.deadline));
  const need = Number(b.minShips);
  const graceEnd = Number(b.deadline) + GRACE;
  const retired = escrowRetired === true;
  // A retired escrow releases nothing and takes no more $WIF; every backer's refund is open now.
  const inWindow = !b.paid && !retired && now() <= graceEnd;
  // HEY's answer counts only when it is for this bounty's project: the slug's hash the escrow will check.
  const signed = att?.ok && sameHash(att.body.attestation?.project, b.project);
  let have = null, note = '', blocked = false;
  if (!b.paid && retired) {
    blocked = true;
    note = mine > 0n ? RETIRED_MESSAGE : 'This escrow was retired by its guardian: this bounty can no longer be released or added to, and its backers can take their $WIF back now.';
  } else if (!b.paid && !slugOk) {
    blocked = true;
    note = `This bounty cannot be released: the slug it was opened with is not a HEY slug. Backers can refund after ${day(graceEnd)}.`;
  } else if (signed) {
    have = Number(att.body.attestation.ships);
  } else if (att?.status === 403) {
    blocked = true;
    note = 'HEY doesn’t tie this payout address to the project, so it will never release. Backers can take their $WIF back after the deadline.';
  } else if (att?.status === 404) {
    blocked = true;
    note = 'HEY has no published project at this slug, so it will not sign a release for it now.';
  }
  // No signed count, no claim of one: HEY's timeline is not what the escrow releases on (it counts each kind once a day
  // and only ships HEY recorded inside the window), so the page says the count is unavailable rather than guess.
  const unavailable = !pending && !b.paid && !note && !signed && until >= Number(b.start);
  // HEY could not be asked (offline, busy, paused): its tie is unknown, so nothing that sends $WIF or tells the
  // project about the bounty is offered until HEY answers. Copy link and the explorer stay.
  if (unavailable && now() < Number(b.deadline)) {
    blocked = true;
    note = 'HEY can’t be reached right now, so adding $WIF and sharing are off until it answers. Try again shortly.';
  }
  const met = have !== null && have >= need;
  const state = b.paid ? ['ok', 'Paid out']
    : retired ? ['off', 'Escrow retired · backers can take back']
    : !slugOk ? ['off', 'Cannot be released · not a HEY slug']
    : att?.status === 403 ? ['off', 'Payout address not tied']
    : att?.status === 404 ? ['off', 'Not on HEY · cannot release now']
    : pending && inWindow ? ['wait', 'Reading HEY…']
    : met && inWindow ? ['ok', 'Target met · ready to release']
    : unavailable && inWindow ? ['wait', 'HEY count unavailable · try again shortly']
    : now() > graceEnd ? ['off', 'Closed · backers can take back']
    : now() > Number(b.deadline) ? ['wait', 'Deadline passed · grace period']
    : ['wait', 'Building'];
  const pct = b.paid ? 100 : have === null ? 0 : Math.min(100, Math.round((have / need) * 100));
  const name = slugOk ? project?.name ?? slug : slug.length > 60 ? `${slug.slice(0, 60)}…` : slug;
  const actions = [];
  if (met && inWindow && !blocked) actions.push(`<button class="go" data-act="claim" data-id="${id}">Release to builder</button>`);
  if (!pending && !blocked && !b.paid && !retired && now() < Number(b.deadline)) actions.push(`<button data-act="fund" data-id="${id}">Add ${T.symbol}</button><span class="fund-box" data-fund-box="${id}" hidden><input type="number" inputmode="decimal" min="0" step="any" placeholder="1000" aria-label="${T.symbol} to add"><button class="go" data-act="fund" data-id="${id}">Add</button></span>`);
  if (!b.paid && (retired || now() > graceEnd) && mine > 0n) actions.push(`<button data-act="refund" data-id="${id}">Take back ${fmt(mine)} ${T.symbol}</button>`);
  const open = !b.paid && !blocked && !retired && now() <= Number(b.deadline);
  // An open bounty is shared only once HEY has answered for it with a count for this project (so the payout is tied).
  const share = slugOk ? shareText({ id, b, name: project?.name ?? slug, open: open && signed }) : null;
  if (share) actions.push(`<a class="share" href="${esc(xIntent(share))}" target="_blank" rel="noopener">Share on X</a>`);
  // Tell the builder: once HEY has been read for the card, on a bounty that can still be met or is met and in window.
  if (slugOk && signed && !pending && !blocked && !retired && (open || (met && inWindow))) {
    const tell = tellText({ id, b, name: project?.name ?? slug, handle: officialHandle(project), have });
    actions.push(`<a class="share" href="${esc(xIntent(tell))}" target="_blank" rel="noopener">Tell the builder</a>`);
  }
  if (slugOk) actions.push(`<button class="link-btn" type="button" data-copy-link="${id}">Copy link</button><input class="linkbox mono" readonly hidden aria-label="Link to bounty #${id}">`);
  if (slugOk) actions.push(`<a class="link-btn" href="./?project=${encodeURIComponent(slug)}">Project view</a>`);
  const list = signed ? countedShips(att, ships) : '';
  const progressLabel = b.paid ? 'Released' : have === null ? 'Ships HEY counted' : `${have} of ${need} ships counted`;
  const where = slugOk
    ? `<a class="slug" href="${CONFIG.hey}/project/${encodeURIComponent(slug)}" target="_blank" rel="noopener">heyresearch.xyz/project/${esc(slug)}</a>`
    : '<span class="slug">opened with a slug that is not a HEY slug</span>';
  const status = b.paid ? 'paid' : retired ? 'retired' : 'open';
  const [leftK, leftV] = countdownParts(Number(b.deadline), status);
  return `<article class="card bounty" id="bounty-${id}" data-on="robinhood" data-slug="${slugOk ? esc(slug) : ''}" data-start="${Number(b.start)}" data-deadline="${Number(b.deadline)}"${pending ? ' data-pending="1"' : ''}>
    <div class="top">
      <div class="id">${logo(project?.logoUrl, name)}<div><span class="name">${esc(name)}</span>${where}</div></div>
      <div class="tags">${badge('robinhood')}<span class="chip ${state[0]}">${state[1]}</span></div>
    </div>
    <div class="facts">
      <div class="fact"><div class="k">Locked</div><div class="v">${fmt(b.total)} ${T.symbol}</div></div>
      <div class="fact left" data-rcount data-deadline="${Number(b.deadline)}" data-status="${status}"><div class="k">${leftK}</div><div class="v">${leftV}</div></div>
      <div class="fact"><div class="k">Burn on payout</div><div class="v">${(Number(b.burnBps) / 100).toFixed(1)}%</div></div>
      <div class="fact"><div class="k">Pays</div><div class="v"><a class="mono" href="${addrUrl(b.builder)}" target="_blank" rel="noopener">${short(b.builder)}</a></div></div>
    </div>
    <dl class="when">
      <div><dt>Ship by</dt><dd data-when="ship">${utcShort(Number(b.deadline))}</dd></div>
      <div><dt>Claim until</dt><dd data-when="claim">${utcShort(graceEnd)}</dd></div>
      <div><dt>Refunds from</dt><dd data-when="refund">${utcShort(graceEnd + 1)}</dd></div>
    </dl>
    <div class="progress">
      <div class="lbl"><span>${progressLabel}</span><span>${b.paid ? '' : `target ${need}`}</span></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${have ?? 0}"><i style="width:${pct}%"></i></div>
    </div>
    ${note ? `<p class="hint bad" style="margin:0">${esc(note)}</p>` : list || (b.paid || pending ? '' : '<p class="hint" style="margin:0">No counted ships since the bounty opened yet.</p>')}
    <div class="actions">${actions.join('')}<span class="mono">#${id} · opened ${day(b.start)}${mine > 0n ? ` · you locked ${fmt(mine)} ${T.symbol}` : ''}</span></div>
  </article>`;
}

// ------------------------------------------------------------------ the card's countdown
const pad2 = (x) => String(x).padStart(2, '0');
const utcShort = (s) => { const d = new Date(Number(s) * 1000); return `${day(s)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; };
/** What is left to ship, then to claim, then nothing: by the reader's clock, like the NEAR cards. */
function countdownParts(deadline, status) {
  const t = now();
  if (status === 'paid') return ['Time left', 'Paid out'];
  if (status === 'retired') return ['Time left', 'Escrow retired'];
  if (t < deadline) return ['Time left to ship', span(deadline - t)];
  if (t <= deadline + GRACE) return ['Time left to claim', span(deadline + GRACE - t)];
  return ['Time left', 'Closed'];
}
function tickCountdowns() {
  document.querySelectorAll('[data-rcount]').forEach((el) => {
    const [k, v] = countdownParts(Number(el.dataset.deadline), el.dataset.status);
    const kEl = el.querySelector('.k'), vEl = el.querySelector('.v');
    if (kEl.textContent !== k) kEl.textContent = k;
    if (vEl.textContent !== v) vEl.textContent = v;
  });
}
// Once a minute, on the minute: only the countdown's text changes, in a cell of fixed height.
setTimeout(() => { tickCountdowns(); setInterval(tickCountdowns, 60_000); }, (60 - new Date().getSeconds()) * 1000);

/** A factual post for X about one bounty: open (what it pays and when) or paid (what the builder received). */
const PAGE_LINK = 'hey-research-lab.github.io/proof-of-ship';
const bountyLink = (id) => `${PAGE_LINK}#bounty-${id}`;
const bountyUrl = (id) => `https://${PAGE_LINK}/#bounty-${id}`;
const xIntent = (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
const dayMonth = (s) => new Date(Number(s) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function shareText({ id, b, name, open }) {
  const need = Number(b.minShips);
  const ships = `${need} ship${need === 1 ? '' : 's'}`;
  if (b.paid) {
    const paid = b.total - (b.total * BigInt(b.burnBps)) / 10_000n;
    return `${name} shipped and claimed ${fmt(paid)} $${T.symbol} from a Proof of Ship bounty, released when Hey Research Lab counted ${ships}. ${bountyLink(id)}`;
  }
  if (!open) return null;
  return `${fmt(b.total)} $${T.symbol} for ${name}, released only when Hey Research Lab counts ${ships} by ${dayMonth(b.deadline)}. If they don't ship, the backers take it back. ${bountyLink(id)}`;
}

/** The project's official X handle, only when HEY reads the account as active and holds no hold on its link. */
const officialHandle = (project) => {
  const x = project?.officialX;
  const handle = typeof x?.handle === 'string' ? x.handle.replace(/^@/, '') : '';
  return x?.status === 'ACTIVE' && (x.linkHeld === null || x.linkHeld === undefined) && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
};
/** A factual post that tells the builder a bounty is waiting: tagged only through officialHandle, else the name. */
function tellText({ id, b, name, handle, have }) {
  const need = Number(b.minShips);
  const who = handle ? `@${handle}` : `${name},`;
  const amount = `${fmt(b.total)} $${T.symbol}`;
  if (have !== null && have >= need) {
    return `${who} there's ${amount} waiting for you on Proof of Ship: Hey Research Lab counts ${have} of your ships, enough to release it now. Anyone can press Release and it goes to your payout wallet. ${bountyLink(id)}`;
  }
  const left = have ? need - have : need;
  const ships = have ? `${left} more` : `${left} ship${left === 1 ? '' : 's'}`;
  return `${who} there's ${amount} waiting for you on Proof of Ship: Hey Research Lab counts your ships, and ${ships} by ${dayMonth(b.deadline)} releases it. Nothing to apply for, just keep shipping. ${bountyLink(id)}`;
}

async function act(kind, id) {
  await needWallet();
  if (kind === 'fund') {
    const box = document.querySelector(`[data-fund-box="${id}"]`);
    if (box && box.hidden) { box.hidden = false; box.querySelector('input')?.focus(); return; }
    const amount = parseAmount(box?.querySelector('input')?.value);
    if (amount === null) throw new Error(`Enter how much ${T.symbol} to add, as a plain number above 0.`);
    if (await readRetired()) throw new Error(RETIRED_MESSAGE);
    const [b, slug] = await Promise.all([
      pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bounty', args: [BigInt(id)] }),
      pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'slugOf', args: [BigInt(id)] }),
    ]);
    if (!bountySlugOk(slug, b.project)) throw new Error('This bounty cannot be released (the slug it was opened with is not a HEY slug), so nothing more can be added.');
    // Asked again now, whatever the card showed when it was drawn: $WIF is added only to a payout HEY ties today.
    const tie = await builderTie(slug, b.builder);
    if (!tie.ok) throw new Error(tie.known ? `Nothing was added. ${tie.text}` : 'HEY can’t be reached right now, so nothing was added. Try again shortly.');
    const bal = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [account] });
    if (amount > bal) throw new Error(`You hold ${fmt(bal)} ${T.symbol}.`);
    await ensureAllowance(amount);
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'fund', args: [BigInt(id), amount] }, 'Add to bounty');
  } else if (kind === 'claim') {
    if (await readRetired()) throw new Error(RETIRED_MESSAGE);
    const b = await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bounty', args: [BigInt(id)] });
    const slug = await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'slugOf', args: [BigInt(id)] });
    if (!bountySlugOk(slug, b.project)) throw new Error('This bounty cannot be released: the slug it was opened with is not a HEY slug.');
    toast('Asking HEY to sign the ship count…', true);
    // HEY signs only for a payout address the project verified to HEY; the escrow checks it equals the bounty's builder.
    const res = await heyAttestation(slug, b.builder, Number(b.start), Math.min(now() - 120, Number(b.deadline)));
    if (!res.ok) throw new Error(res.body.message ?? `HEY answered ${res.status}`);
    const a = res.body.attestation;
    const att = { project: a.project, builder: getAddress(a.builder), since: BigInt(a.since), until: BigInt(a.until), ships: Number(a.ships), evidence: a.evidence, issuedAt: BigInt(a.issuedAt) };
    // Everything the escrow checks, checked here first, so a mismatch is a sentence and not a reverted transaction.
    if (!sameHash(att.project, b.project)) throw new Error('HEY signed for a different project than this bounty’s; nothing was sent.');
    if (att.since !== BigInt(b.start)) throw new Error('HEY’s count starts at a different time than this bounty; nothing was sent.');
    if (att.until > BigInt(b.deadline)) throw new Error('HEY’s count runs past this bounty’s deadline; nothing was sent.');
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

function fail(err) { toast(String(err?.shortMessage ?? err?.message ?? err)); }
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
