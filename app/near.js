import { formatUnits, parseUnits, getAddress, isAddress, keccak256, recoverTypedDataAddress, stringToBytes } from './vendor/viem.js?v=7';
import { NEAR } from './near-config.js?v=1';

/*
 * Proof of Ship on NEAR: the chain switch, and the whole NEAR flow (open, fund, list, claim, refund) against
 * escrow.heyresearch.near. It shares nothing with app.js but the page's styles and the toast: the Robinhood Chain flow
 * runs exactly as before whichever chain is shown. Reading needs no wallet; the wallet code (NEAR Wallet Selector with
 * Meteor and MyNearWallet, vendor/near.js) loads only when a reader connects.
 */

// The page never runs inside another site's frame (app.js says so and replaces the page); nothing here is wired then.
const framed = (() => { try { return window.top !== window.self; } catch { return true; } })();
if (framed) throw new Error('Proof of Ship does not run inside a frame.');

const $ = (s) => document.querySelector(s);
const T = NEAR.token;
const GRACE = 3 * 86400;
const TGAS = 1_000_000_000_000n;
const YOCTO_PER_NEAR = 10n ** 24n;
const CREATE_DEPOSIT = 10n ** 22n; // 0.01 NEAR for the bounty's storage; the escrow sends back what it does not use
const ONE_YOCTO = 1n;

// ------------------------------------------------------------------ helpers
let toastTimer;
/** Plain text, or DOM nodes: nothing from a wallet, HEY, the chain or an error message is parsed as HTML. */
const toast = (msg, sticky = false) => {
  clearTimeout(toastTimer);
  const el = $('#toast');
  if (msg instanceof Node) el.replaceChildren(msg); else el.textContent = msg || '';
  if (msg && !sticky) toastTimer = setTimeout(() => { el.replaceChildren(); }, 6000);
};
const linkToast = (before, href, linkText, after = '') => {
  const f = document.createDocumentFragment();
  f.append(before, Object.assign(document.createElement('a'), { href, target: '_blank', rel: 'noopener', textContent: linkText }), after);
  return f;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const num = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const fmt = (v) => num(formatUnits(BigInt(v), T.decimals));
const compact = (v) => {
  const n = Number(formatUnits(BigInt(v), T.decimals));
  return n >= 1e6 ? `${num(n / 1e6, 2)}M` : n >= 1e4 ? `${num(n / 1e3, 1)}K` : num(n);
};
const day = (s) => new Date(Number(s) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const now = () => Math.floor(Date.now() / 1000);
const pad2 = (n) => String(n).padStart(2, '0');
/** "Tuesday, 18 November 2026, 19:48" for a unix time, in UTC or the reader's own time zone. */
function when(s, timeZone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Number(s) * 1000)).map((p) => [p.type, p.value]));
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}
/** "18 Nov 2026, 19:48 UTC". */
const utcShort = (s) => { const d = new Date(Number(s) * 1000); return `${day(s)}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; };
const dayMonth = (s) => new Date(Number(s) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const times = (n) => (Number(n) === 1 ? 'once' : `${n} times`);
/** "3d 04h 12m", "4h 05m", "12m": a span of seconds, always the same shape for the same number of units. */
function span(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${pad2(h)}h ${pad2(m)}m` : h ? `${h}h ${pad2(m)}m` : `${m}m`;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const httpsUrl = (url) => { try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
const initial = (name) => (String(name ?? '').match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
const logo = (url, name) => httpsUrl(url)
  ? `<img src="${esc(httpsUrl(url))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-logo data-initial="${esc(initial(name))}">`
  : `<span class="ph" aria-hidden="true" title="${esc(name)}">${esc(initial(name))}</span>`;
function wireLogos(root) {
  root.querySelectorAll('img[data-logo]').forEach((img) => {
    const swap = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'ph', textContent: img.dataset.initial ?? '' }));
    if (img.complete && img.naturalWidth === 0) swap();
    else img.addEventListener('error', swap, { once: true });
  });
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const isHeySlug = (slug) => SLUG_RE.test(slug);
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const SLUG_FORM_MESSAGE = 'Use the project’s HEY slug exactly as in heyresearch.xyz/project/slug: lower-case letters, digits and hyphens, no spaces. The escrow refuses any other.';
/** A NEAR account id as NEAR writes it (2 to 64 characters, lower-case). */
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const accountUrl = (a) => `${NEAR.explorer}/address/${encodeURIComponent(a)}`;
const txUrl = (h) => { if (!TX_RE.test(String(h))) throw new Error('The wallet answered with something that is not a NEAR transaction hash.'); return `${NEAR.explorer}/txns/${h}`; };
/** The NEAR account an EVM address controls: its eth-implicit account, `0x` and 40 lower-case hex characters. */
const ethImplicit = (address) => String(address).toLowerCase();
/** A plain decimal amount of USDC, at most 6 decimals: "100", "12.5". */
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;
const AMOUNT_MESSAGE = `Enter the ${T.symbol} as a plain number above 0 with at most 6 decimals, e.g. 100.`;
const parseAmount = (text) => {
  const t = String(text ?? '').trim();
  if (!AMOUNT_RE.test(t)) return null;
  try { const v = parseUnits(t, T.decimals); return v > 0n ? v : null; } catch { return null; }
};
function fail(err) { toast(plainError(err)); }

// ------------------------------------------------------------------ the chain switch
/** Which chain the page shows: Robinhood Chain unless the address asks for NEAR (?chain=near or #near-bounty-<id>). */
function chainFromUrl() {
  const q = new URLSearchParams(location.search).get('chain');
  if (q === 'near') return 'near';
  if (q === 'robinhood') return 'robinhood';
  return /^#near-bounty-\d{1,9}$/.test(location.hash) ? 'near' : 'robinhood';
}
let started = false;
function setChain(chain, write = true) {
  document.querySelectorAll('[data-chain]').forEach((el) => { el.hidden = el.dataset.chain !== chain; });
  document.querySelectorAll('#chainSwitch [data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === chain)));
  document.documentElement.dataset.shown = chain;
  if (write) {
    const u = new URL(location.href);
    if (chain === 'near') u.searchParams.set('chain', 'near'); else u.searchParams.delete('chain');
    if (chain !== 'near' && /^#near-/.test(u.hash)) u.hash = '';
    history.replaceState(null, '', u);
  }
  if (chain === 'near' && !started) { started = true; start().catch(fail); }
}
document.querySelectorAll('#chainSwitch [data-pick]').forEach((b) => b.addEventListener('click', () => setChain(b.dataset.pick)));

// ------------------------------------------------------------------ NEAR reads (public RPC, no key)
const utf8 = new TextEncoder();
const b64 = (s) => { let bin = ''; for (const byte of utf8.encode(s)) bin += String.fromCharCode(byte); return btoa(bin); };
/** JSON-RPC errors that are an answer, not a busy node: asking the next node would get the same one. */
const FINAL_RPC = new Set(['CONTRACT_EXECUTION_ERROR', 'UNKNOWN_ACCOUNT', 'NO_CONTRACT_CODE', 'INVALID_ACCOUNT', 'UNKNOWN_TRANSACTION']);
async function rpc(method, params) {
  let last = null;
  for (const url of NEAR.rpcs) {
    let j;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'pos', method, params }) });
      if (!r.ok) { last = new Error(`NEAR RPC answered ${r.status}.`); continue; }
      j = await r.json();
    } catch { last = new Error('NEAR RPC could not be reached.'); continue; }
    if (j?.error) {
      const e = new Error(String(j.error?.data ?? j.error?.cause?.info?.error_message ?? j.error?.message ?? 'NEAR RPC error'));
      if (FINAL_RPC.has(j.error?.cause?.name)) throw e;
      last = e;
      continue;
    }
    return j.result;
  }
  throw last ?? new Error('NEAR RPC could not be reached.');
}
/** A contract's view method, its JSON answer parsed. */
async function view(contract, method, args = {}) {
  const res = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: b64(JSON.stringify(args)) });
  if (res?.error) throw new Error(String(res.error));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}
/** The chain's clock, from the latest final block (never the reader's). */
async function chainNow() {
  const b = await rpc('block', { finality: 'final' });
  return Number(BigInt(b.header.timestamp) / 1_000_000_000n);
}
const usdcBalance = (accountId) => view(T.account, 'ft_balance_of', { account_id: accountId }).then((v) => BigInt(v));

// ------------------------------------------------------------------ HEY reads (public API, no key)
const projectCache = new Map();
async function heyProject(slug) {
  if (projectCache.has(slug)) return projectCache.get(slug);
  const r = await fetch(`${NEAR.hey}/api/projects/${encodeURIComponent(slug)}`);
  if (r.status === 404) { projectCache.set(slug, null); return null; }
  if (!r.ok) throw new Error(`HEY answered ${r.status}`);
  const j = await r.json();
  const p = j.project ?? j;
  projectCache.set(slug, p);
  return p;
}
/** HEY's signed count for a window, for the NEAR escrow (`escrow=near:escrow.heyresearch.near`). */
async function heyAttestation(slug, builder, since, until) {
  const u = new URL(`${NEAR.hey}/api/v1/proof-of-ship/attestation`);
  u.searchParams.set('slug', slug);
  u.searchParams.set('builder', builder);
  u.searchParams.set('since', String(since));
  u.searchParams.set('until', String(until));
  u.searchParams.set('escrow', NEAR.heyEscrow);
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j && typeof j === 'object' ? j : {} };
}
/**
 * Whether an answer means HEY is not signing for this NEAR escrow (yet): a 400 about the escrow (the route before its
 * NEAR deploy, or an escrow it does not sign for) or a 503 (no key, or paused). Nothing else reads as "not signing".
 */
const notSigning = (res) => Boolean(res) && ((res.status === 400 && /escrow/i.test(String(res.body?.message ?? ''))) || res.status === 503);
const NOT_SIGNING_TEXT = 'HEY is not signing for the NEAR escrow right now, so no NEAR bounty can be released until it does. Refunds after the deadline never need HEY.';
/**
 * HEY's unsigned count for one closed window, by the payout rule (`/api/v1/proof-of-ship/ships`): `{ ships }`, or
 * `{ ships: null, reason, reasonText }` when HEY can't measure the window (never read as 0), or `{ error }`.
 */
async function heyShips(slug, since, until) {
  const u = new URL(`${NEAR.hey}/api/v1/proof-of-ship/ships`);
  u.searchParams.set('slug', slug);
  u.searchParams.set('since', String(since));
  u.searchParams.set('until', String(until));
  let r;
  try { r = await fetch(u); } catch { return { error: true }; }
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (!j || typeof j !== 'object') return { error: true };
  if (Number.isInteger(j.ships) && j.ships >= 0) return { ships: j.ships };
  if (j.ships === null) return { ships: null, reason: typeof j.reason === 'string' ? j.reason : '', reasonText: typeof j.reasonText === 'string' ? j.reasonText : '' };
  return { error: true };
}
async function shipTitles(slug, ids) {
  const want = new Set(ids);
  if (!want.size) return [];
  const r = await fetch(`${NEAR.hey}/api/projects/${encodeURIComponent(slug)}/timeline?limit=200`).catch(() => null);
  if (!r?.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.items ?? []).filter((it) => want.has(it.id));
}
async function heySuggest(q, signal) {
  const r = await fetch(`${NEAR.hey}/api/search/suggest?q=${encodeURIComponent(q)}`, { signal });
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
const tieCache = new Map();
const TIE_KINDS = ['token_deployer', 'wallet_claim'];
/** The payout addresses HEY would sign for (the tie does not depend on the escrow); null when HEY could not say. */
async function heyTie(slug) {
  if (tieCache.has(slug)) return tieCache.get(slug);
  let r;
  try { r = await fetch(`${NEAR.hey}/api/v1/proof-of-ship/tie?slug=${encodeURIComponent(slug)}`); } catch { return null; }
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
    tie = { payable: j.payable, ties: j.payable ? [...byAddr.values()] : [], reason: typeof j.reason === 'string' ? j.reason : '', paused: j.attestationsPaused === true };
  }
  if (r.status < 500) tieCache.set(slug, tie);
  return tie;
}
const TIE_WORDS = { token_deployer: 'its token deployer', wallet_claim: 'the wallet that signed the project’s claim on HEY' };
const tieWords = (kinds) => kinds.map((k) => TIE_WORDS[k]).join(', and ');
const TIE_REASONS = {
  no_token: 'it has no token HEY tracks, so no deployer or claim can be tied to it',
  token_not_verified: 'the project hasn’t confirmed the token HEY tracks as its own yet',
  issuer_token: 'its token is issued by Robinhood, not by the project',
  site_disclaims_contract: 'its own site says the token HEY tracks is not its own',
  site_names_another_contract: 'its own site names another contract than the token HEY tracks',
  contested: 'another page on HEY claims the same token',
  no_tie: 'HEY ties no wallet to it yet: the deployer is a shared launch service or not read, and no wallet has signed a claim for it',
};
const tieReason = (code) => TIE_REASONS[code] ?? 'HEY ties no wallet to it yet';

/** The EIP-712 domain the NEAR escrow checks: chain id 397 and a salt binding it to this one escrow account. */
const DOMAIN = { name: 'HEY Proof of Ship', version: '1', chainId: NEAR.chainId, salt: keccak256(stringToBytes(NEAR.escrow)) };
const SHIPS_TYPES = {
  Ships: [
    { name: 'project', type: 'bytes32' }, { name: 'builder', type: 'address' }, { name: 'since', type: 'uint64' },
    { name: 'until', type: 'uint64' }, { name: 'ships', type: 'uint32' }, { name: 'evidence', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
};
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
/**
 * Whether an answer is HEY's signature over this project and payout address under the NEAR escrow's own domain: the
 * domain is built here from the escrow's account id, never read from the answer, and the signer must be the attester
 * fixed in the escrow.
 */
async function attestationSignedFor(body, slug, builder) {
  const a = body?.attestation;
  if (!a || typeof body.signature !== 'string' || !SIG_RE.test(body.signature)) return false;
  if (!isAddress(String(a.builder ?? '')) || !sameHash(a.builder, builder)) return false;
  if (!sameHash(a.project, keccak256(stringToBytes(slug))) || !BYTES32_RE.test(String(a.evidence ?? ''))) return false;
  try {
    const message = {
      project: a.project, builder: getAddress(a.builder), since: BigInt(a.since), until: BigInt(a.until),
      ships: Number(a.ships), evidence: a.evidence, issuedAt: BigInt(a.issuedAt),
    };
    const signer = await recoverTypedDataAddress({ domain: DOMAIN, types: SHIPS_TYPES, primaryType: 'Ships', message, signature: body.signature });
    return sameHash(signer, NEAR.attester);
  } catch { return false; }
}
/** Whether HEY ties a payout address to the project, asked over a one-minute window for the NEAR escrow. */
async function builderTie(slug, builder) {
  const t = now() - 120;
  const res = await heyAttestation(slug, builder, t - 60, t).catch(() => null);
  if (res?.ok) {
    if (!(await attestationSignedFor(res.body, slug, builder))) {
      return { ok: false, known: true, text: 'HEY’s answer for this address is not HEY’s signature for the NEAR escrow, this project and this address, so the page will not open a bounty for it.' };
    }
    const how = res.body.builderTie === 'wallet_claim' ? 'it signed for the project’s token to claim the project on HEY' : 'it deployed the project’s verified token';
    return { ok: true, known: true, text: `HEY ties this address to the project: ${how}. HEY’s signature for the NEAR escrow checks out.` };
  }
  if (notSigning(res)) return { ok: false, known: true, notSigning: true, text: `${NOT_SIGNING_TEXT} Opening is off until it does, so no USDC is locked behind a payout HEY cannot sign.` };
  if (res?.status === 403) return { ok: false, known: true, text: `HEY doesn’t tie this address to the project, so it would never sign a payout to it. ${res.body?.message ?? ''}`.trim() };
  if (res?.status === 400 || res?.status === 404) return { ok: false, known: true, text: String(res.body?.message ?? 'HEY refused this project.') };
  return { ok: false, known: false, text: 'HEY couldn’t check this payout address just now; try again shortly.' };
}

// ------------------------------------------------------------------ wallet (NEAR Wallet Selector, loaded on demand)
/*
 * A test wallet stands in for Meteor only on a local development host, so the page's Playwright checks can drive the
 * whole flow; the published page (github.io) never reads it.
 */
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const testWallet = () => (LOCAL ? window.__posNearTestWallet ?? null : null);
const SELECTED = 'near-wallet-selector:selectedWalletId';
const WALLETS = [
  { id: 'meteor-wallet', name: 'Meteor Wallet', note: 'extension or web' },
  { id: 'my-near-wallet', name: 'MyNearWallet', note: 'web' },
];
let selectorPromise = null, mod = null, wallet = null, account = null, walletName = null, heldUsdc = null;
function loadSelector() {
  selectorPromise ??= import('./vendor/near.js?v=1').then(async (m) => {
    mod = m;
    return m.setupWalletSelector({
      network: NEAR.networkId,
      fallbackRpcUrls: NEAR.rpcs,
      modules: [m.setupMeteorWallet(), m.setupMyNearWallet()],
    });
  });
  selectorPromise.catch(() => { selectorPromise = null; });
  return selectorPromise;
}
function openPicker() {
  const dlg = $('#nearWallets');
  const list = $('#nearWalletList');
  const tw = testWallet();
  const options = tw ? [{ id: 'test', name: tw.name ?? 'Test wallet', note: 'local test' }] : WALLETS;
  if (!tw) loadSelector().catch(() => undefined); // starts while the reader picks, so the wallet's popup opens on the click
  list.innerHTML = options.map((w) => `<button class="wallet" data-wallet="${esc(w.id)}"><span class="ph" aria-hidden="true">${esc(initial(w.name))}</span><span>${esc(w.name)}</span><span class="go-arrow">${esc(w.note)}</span></button>`).join('');
  list.querySelectorAll('[data-wallet]').forEach((el) => el.addEventListener('click', () => { dlg.close(); connectWith(el.dataset.wallet).catch(fail); }));
  dlg.showModal();
}
async function connectWith(id) {
  const tw = testWallet();
  if (tw) {
    const accts = await tw.signIn({ contractId: NEAR.escrow });
    await setAccount(accts?.[0]?.accountId, tw.name ?? 'Test wallet');
    return;
  }
  toast('Opening the wallet…', true);
  const selector = await loadSelector();
  const w = await selector.wallet(id);
  const accts = await w.signIn({ contractId: NEAR.escrow, methodNames: [] });
  toast('');
  wallet = w;
  await setAccount(accts?.[0]?.accountId ?? (await w.getAccounts())?.[0]?.accountId, w.metadata?.name ?? id);
}
/** Bring back a wallet the reader connected before, without a prompt. Loads the wallet code only when there was one. */
async function restoreWallet() {
  const tw = testWallet();
  if (tw) { const a = await tw.getAccounts?.(); if (a?.[0]?.accountId) await setAccount(a[0].accountId, tw.name ?? 'Test wallet'); return; }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SELECTED) ?? 'null'); } catch { return; }
  if (!saved) return;
  const selector = await loadSelector();
  if (!selector.isSignedIn()) return;
  const w = await selector.wallet();
  const accts = await w.getAccounts();
  if (!accts?.[0]?.accountId) return;
  wallet = w;
  await setAccount(accts[0].accountId, w.metadata?.name ?? 'NEAR wallet');
}
async function setAccount(accountId, name) {
  if (!accountId || !ACCOUNT_RE.test(String(accountId))) throw new Error('The wallet did not answer with a NEAR account.');
  account = String(accountId);
  walletName = name;
  heldUsdc = null;
  renderAccount();
  showBalance();
  await load();
}
async function disconnect() {
  const tw = testWallet();
  try { if (tw) await tw.signOut?.(); else await wallet?.signOut?.(); } catch { /* the page forgets either way */ }
  wallet = null; account = null; walletName = null; heldUsdc = null;
  renderAccount();
  renderPreview();
  toast('Disconnected.');
  await load();
}
async function showBalance() {
  if (!account) return;
  const bal = await usdcBalance(account).catch(() => null);
  if (bal === null) { $('#nBalHint').textContent = `Couldn't read your ${T.symbol} balance; try again.`; return; }
  heldUsdc = bal;
  renderAccount();
  renderPreview();
}
function renderAccount() {
  const on = Boolean(account);
  $('#nConnect').hidden = on;
  $('#nAccount').hidden = !on;
  if (!on) { $('#nAccountMenu').hidden = true; return; }
  $('#nAccount').innerHTML = `<span class="dot"></span><span>${esc(short(account))}</span>${heldUsdc !== null ? `<span class="muted">${compact(heldUsdc)} ${T.symbol}</span>` : ''}`;
  $('#nAcctWallet').textContent = walletName ?? 'NEAR wallet';
  $('#nAcctAddr').textContent = account;
  $('#nAcctUsdc').textContent = heldUsdc !== null ? `${fmt(heldUsdc)} ${T.symbol}` : '—';
  $('#nAcctExplorer').href = accountUrl(account);
}
async function needWallet() {
  if (!account) openPicker();
  if (!account) throw new Error('Connect a NEAR wallet first, then press the button again.');
}

/** A contract's error code in plain words; a code the page does not know is shown as the contract wrote it. */
const ERR_WORDS = {
  ERR_NOT_ENOUGH_SHIPS: 'HEY counts fewer ships than the bounty needs.',
  ERR_STALE_ATTESTATION: 'HEY’s signature is too old or dated ahead of the chain; check HEY’s count again.',
  ERR_CLAIM_CLOSED: 'The claim window (deadline plus 3 days) has closed.',
  ERR_ALREADY_CLAIMED: 'This bounty was already claimed.',
  ERR_REFUND_NOT_OPEN: 'Refunds open after the deadline plus 3 days.',
  ERR_NOTHING_TO_REFUND: 'You have nothing in this bounty to take back.',
  ERR_RETIRED: 'The escrow is retired: claims and new bounties are off, refunds are open.',
  ERR_BAD_DEADLINE: 'The deadline must be 1 to 365 days from now.',
  ERR_FUNDING_CLOSED: 'This bounty’s deadline has passed; it takes no more USDC.',
  ERR_NOT_OPEN: 'This bounty no longer takes USDC.',
  ERR_WRONG_WINDOW: 'HEY’s count is for a different window than this bounty’s.',
  ERR_WRONG_BUILDER: 'HEY’s signature names a different payout address than this bounty’s.',
  ERR_WRONG_PROJECT: 'HEY’s signature is for a different project than this bounty’s.',
  ERR_WRONG_SIGNER: 'The signature is not HEY’s attester over this escrow.',
};
function plainError(err) {
  const raw = String(err?.shortMessage ?? err?.message ?? err ?? '');
  const code = /ERR_[A-Z_]+/.exec(raw)?.[0];
  return code ? `${ERR_WORDS[code] ?? raw.slice(raw.indexOf(code), raw.indexOf(code) + 160)} (${code})` : raw.slice(0, 300);
}
/** The value a transaction returned, decoded; a failed transaction throws its contract error. */
function outcomeValue(o) {
  const s = o?.status;
  if (s && typeof s === 'object' && 'Failure' in s) throw new Error(JSON.stringify(s.Failure));
  const v = s?.SuccessValue;
  if (typeof v !== 'string') return undefined;
  if (v === '') return null;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))); } catch { return undefined; }
}
const outcomeHash = (o) => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;
/** One transaction with one function call, signed in the reader's wallet. */
async function sendCall(receiverId, method, args, gas, deposit, label) {
  await needWallet();
  toast(`${label}: confirm in your wallet…`, true);
  const tw = testWallet();
  let outcome;
  if (tw) {
    outcome = await tw.signAndSendTransaction({ signerId: account, receiverId, actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: String(gas), deposit: String(deposit) } }] });
  } else {
    if (!mod || !wallet) throw new Error('Connect a NEAR wallet first.');
    outcome = await wallet.signAndSendTransaction({ signerId: account, receiverId, actions: [mod.actionCreators.functionCall(method, args, gas, deposit)] });
  }
  const hash = outcomeHash(outcome);
  const value = outcomeValue(outcome);
  return { hash: hash && TX_RE.test(hash) ? hash : null, value };
}
const txDone = (text, hash) => (hash ? linkToast(`${text} `, txUrl(hash), 'View on nearblocks') : text);

let busy = false;
function setBusy(on) {
  busy = on;
  $('#nCreate').inert = on || retired === true;
  document.querySelectorAll('#nearView [data-nact], #nearView .fund-box input, #nFundBtn').forEach((el) => { el.disabled = on; });
  renderPreview();
}
async function runExclusive(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); }
}

// ------------------------------------------------------------------ the escrow
let config = null, retired = null;
async function readConfig() {
  config = await view(NEAR.escrow, 'get_config');
  const r = config.retired === true;
  if (r !== retired) { retired = r; renderRetired(); }
  return config;
}
function renderRetired() {
  const on = retired === true;
  $('#nRetired').hidden = !on;
  $('#nOpenBtn').hidden = on;
  $('#nRetiredNote').hidden = !on;
  $('#nCreate').inert = on || busy;
}
function renderContract() {
  $('#nContractFacts').innerHTML = [
    ['Escrow on NEAR', NEAR.escrow],
    ['USDC on NEAR', T.account],
    ['HEY attester (an EVM key, fixed at init)', NEAR.attester, null],
  ].map(([k, v, link]) => `<div><div class="k">${esc(k)}</div>${link === null ? `<span class="mono">${esc(v)}</span>` : `<a href="${esc(accountUrl(v))}" target="_blank" rel="noopener">${esc(v)}</a>`}</div>`).join('');
}

// ------------------------------------------------------------------ composer
const form = $('#nCreate');
let payoutMode = 'near';
function readForm() {
  const amountStr = String($('#nAmount').value ?? '').trim();
  const parsed = parseAmount(amountStr);
  return {
    slug: String($('#nSlug').value || '').trim(),
    builder: String($('#nBuilder').value || '').trim(),
    minShips: Math.max(0, Math.floor(Number($('#nMinShips').value) || 0)),
    days: Math.max(0, Math.floor(Number($('#nDays').value) || 0)),
    amount: parsed ?? 0n,
    amountOk: parsed !== null,
    payout: payoutMode,
  };
}
const PAYOUT_HINT = {
  near: 'Paid to the builder’s NEAR account 0x…, the eth-implicit account of the EVM address HEY ties. The same Ethereum wallet controls it.',
  intents: 'Deposited into NEAR Intents (intents.near) for the builder’s 0x… account, which the same Ethereum wallet controls. From there the builder withdraws to another chain.',
};
let pendingFund = null; // { id, amount, slug }: a bounty this page just opened, waiting for step 2
let shownDays = null; // the days the preview last showed, checked again when Open is pressed
let customDays = false;
/**
 * The pressed preset always says what the days field holds: a value a reload or the browser put back (say 1 while
 * "14 days" looked pressed) shows as Custom with the field open, never behind a preset that reads otherwise.
 */
function syncDays(days) {
  const preset = !customDays && ['7', '14', '30'].includes(String(days)) ? String(days) : 'custom';
  if (preset === 'custom') customDays = true;
  pressPreset(preset);
  $('#nDaysCustom').hidden = preset !== 'custom';
}
function renderPreview() {
  const v = readForm();
  shownDays = v.days;
  syncDays($('#nDays').value);
  renderPace();
  $('#nAmt').innerHTML = `${fmt(v.amount)}<small>${T.symbol}</small>`;
  $('#nPay').textContent = `${fmt(v.amount)} ${T.symbol}`;
  $('#nShips').textContent = `${v.minShips || '—'} ship${v.minShips === 1 ? '' : 's'}`;
  const by = now() + v.days * 86400;
  $('#nBy').textContent = v.days ? `${day(by)} · ${v.days} day${v.days === 1 ? '' : 's'}` : '—';
  $('#nRefund').textContent = v.days ? day(by + GRACE) : '—';
  $('#nDaysHint').textContent = v.days ? `Ships counted until ${day(by)}.` : '';
  $('#nPayoutHint').textContent = PAYOUT_HINT[v.payout];
  const acct = isAddress(v.builder) ? ethImplicit(v.builder) : null;
  $('#nAccountOut').innerHTML = acct ? `<a class="mono" href="${esc(accountUrl(acct))}" target="_blank" rel="noopener">${esc(short(acct))}</a>` : '—';
  $('#nRoute').textContent = v.payout === 'intents' ? 'NEAR Intents' : 'NEAR account';
  const bh = $('#nBalHint'), btn = $('#nOpenBtn');
  let over = false;
  if (!v.amountOk) { bh.className = 'hint bad'; bh.textContent = AMOUNT_MESSAGE; }
  else if (heldUsdc !== null) {
    over = v.amount > heldUsdc;
    bh.className = over ? 'hint bad' : 'hint';
    bh.textContent = `${over ? 'More than you hold: ' : 'You hold '}${fmt(heldUsdc)} ${T.symbol} on NEAR.`;
  } else { bh.className = 'hint'; bh.textContent = ''; }
  btn.disabled = over || busy || retired === true || Boolean(pendingFund);
  const p = v.slug ? projectCache.get(v.slug) : undefined;
  const name = p?.name ?? (v.slug || 'the project');
  $('#nSentence').textContent = v.slug && acct
    ? `When HEY counts ${v.minShips} ship${v.minShips === 1 ? '' : 's'} for ${name} by ${day(by)}, ${fmt(v.amount)} ${T.symbol} goes to ${short(acct)} on NEAR${v.payout === 'intents' ? ' Intents' : ''}. If not, you take your ${T.symbol} back.`
    : 'Enter a project and a payout address.';
  const step = $('#nFundStep');
  if (pendingFund) {
    step.hidden = false;
    $('#nFundText').textContent = `Step 1 of 2 done: bounty #${pendingFund.id} is open on NEAR. Step 2: lock ${fmt(pendingFund.amount)} ${T.symbol} in it.`;
    $('#nFundBtn').textContent = `Fund #${pendingFund.id} with ${fmt(pendingFund.amount)} ${T.symbol}`;
    $('#nFundBtn').disabled = busy;
  } else step.hidden = true;
}
// ------------------------------------------------------------------ realistic target: HEY's count of the last 14 days
const PACE_DAYS = 14;
const paceCache = new Map(); // slug -> { until, res } for the last window read
/** The last 14 days, closed and cut to the hour, so the route's 5-minute cache serves every reader the same answer. */
const paceWindow = () => { const until = Math.floor((now() - 300) / 3600) * 3600; return { since: until - PACE_DAYS * 86400, until }; };
async function loadPace(slug) {
  const w = paceWindow();
  if (paceCache.get(slug)?.until === w.until) return;
  paceCache.set(slug, { until: w.until, res: null });
  const res = await heyShips(slug, w.since, w.until);
  if (paceCache.get(slug)?.until === w.until) paceCache.set(slug, { until: w.until, res });
  if (readForm().slug === slug) renderPace();
}
/*
 * The verdict, a rough guide from past shipping and never a forecast: at the last 14 days' pace the project would
 * ship expected = shipped × days ÷ 14 in the bounty's time. The target looks likely when it is at most 3/4 of that,
 * tight up to 5/4 of it, unlikely above it, and unlikely whenever HEY counted none.
 */
function paceVerdict(shipped, target, days) {
  const expected = (shipped * days) / PACE_DAYS;
  if (shipped === 0 || target > expected * 1.25) return 'unlikely';
  return target <= expected * 0.75 ? 'likely' : 'tight';
}
const PACE_REASONS = {
  window_before_hey_read: 'HEY started reading this project less than 14 days ago',
  activity_not_measured: 'HEY does not read this project’s building right now',
};
function renderPace() {
  const el = $('#nPace');
  if (!el) return;
  const v = readForm();
  const p = v.slug && isHeySlug(v.slug) ? projectCache.get(v.slug) : null;
  const res = p ? paceCache.get(v.slug)?.res : undefined;
  if (!p || res === undefined) { el.replaceChildren(); return; }
  const name = esc(p.name ?? v.slug);
  const rule = '<span class="muted">HEY counts at most one ship of each kind a day, and a code week only once that week has ended.</span>';
  if (res === null) { el.innerHTML = `Reading HEY’s count for ${name} over the last 14 days…`; return; }
  if (res.error) { el.innerHTML = `HEY’s count for ${name} over the last 14 days could not be read just now.`; return; }
  if (res.ships === null) {
    const why = String(res.reasonText || PACE_REASONS[res.reason] || 'HEY gave no reason').trim().replace(/\.$/, '');
    el.innerHTML = `<span data-pace="null">HEY can’t measure ${name}’s shipping right now. ${esc(why.replace(/^./, (c) => c.toUpperCase()))}.</span> ${rule}`;
    return;
  }
  const n = res.ships;
  let out = `By HEY’s count, ${name} shipped ${times(n)} in the last 14 days (about ${num(n / 2, 1)} a week).`;
  if (v.minShips >= 1 && v.days >= 1) {
    const verdict = paceVerdict(n, v.minShips, v.days);
    out += ` A target of ${v.minShips} in ${v.days} day${v.days === 1 ? '' : 's'} looks <b class="${verdict}" data-pace="${verdict}">${verdict}</b>.`;
  }
  el.innerHTML = `${out} ${rule}`;
}

let tieState = { slug: null, tie: null };
let tieCheck = { slug: null, builder: null, ok: null, notSigning: false };
let autofilled = null;
function writeBuilder(address) { $('#nBuilder').value = address; autofilled = address; checkBuilder(); renderPreview(); }
function setTie(slug, tie) {
  tieState = { slug, tie };
  const el = $('#nBuilder');
  const mine = el.value.trim() === '' || el.value === autofilled;
  if (tie && mine) {
    if (tie.ties.length === 1) { if (el.value !== tie.ties[0].address) writeBuilder(tie.ties[0].address); }
    else if (autofilled && el.value === autofilled && !tie.ties.some((t) => t.address === autofilled)) writeBuilder('');
  } else if (!tie && slug === null && autofilled && el.value === autofilled) writeBuilder('');
  renderTie();
}
const addrLine = (address) => `<p class="addr-line">Paid on NEAR to <a class="mono" href="${esc(accountUrl(ethImplicit(address)))}" target="_blank" rel="noopener">${esc(ethImplicit(address))} ↗</a></p>`;
function renderTie() {
  const box = $('#nTieBox');
  const { tie, slug } = tieState;
  if (!tie) { box.innerHTML = ''; return; }
  const typed = readForm().builder;
  const parts = [];
  if (tie.paused) parts.push('<p class="note">HEY has paused signing for now. No bounty can be released until it resumes; refunds after the deadline don’t need HEY.</p>');
  if (!tie.payable || !tie.ties.length) {
    parts.push(`<p class="bad">HEY can’t pay this project yet: ${esc(tieReason(tie.reason))}.</p>`);
  } else if (tie.ties.length === 1) {
    const t = tie.ties[0];
    const checked = tieCheck.slug === slug && sameHash(tieCheck.builder, t.address) ? tieCheck : null;
    parts.push(checked?.ok
      ? `<p class="ok">HEY will pay this address: ${esc(tieWords(t.kinds))}.</p>${addrLine(t.address)}`
      : `<p>HEY names this address, ${esc(tieWords(t.kinds))}${checked && checked.ok === false ? ', but HEY did not sign for it on NEAR just now: see the note under the payout address.' : '. Checking HEY’s signature for the NEAR escrow…'}</p>${addrLine(t.address)}`);
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
const checkSlug = debounce(async () => {
  const { slug } = readForm();
  const hint = $('#nSlugHint'), card = $('#nProjectCard');
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
    card.innerHTML = `${logo(p.logoUrl, p.name)}<div><b>${esc(p.name)}</b><span>${esc(String(p.activityStatus ?? '').toLowerCase().replace('_', ' '))} · ${esc(last)}</span></div>`;
    wireLogos(card);
    card.className = 'project on';
    heyTie(slug).then((t) => { if (readForm().slug === slug) setTie(slug, t); }).catch(() => undefined);
    loadPace(slug).catch(() => undefined);
  }
  renderPreview();
  checkBuilder();
}, 350);
const checkBuilder = debounce(async () => {
  const { slug, builder } = readForm();
  const hint = $('#nBuilderHint');
  hint.className = 'hint';
  if (!builder) { hint.textContent = 'The EVM address HEY ties to the project. The builder is paid at its NEAR account, 0x… in lower case.'; renderPreview(); return; }
  if (!isAddress(builder)) { hint.className = 'hint bad'; hint.textContent = 'Not a valid EVM address (0x and 40 hex characters).'; renderPreview(); return; }
  renderPreview();
  if (!slug || !isHeySlug(slug)) return;
  const tie = await builderTie(slug, builder);
  const cur = readForm();
  if (cur.slug !== slug || cur.builder !== builder) return;
  tieCheck = { slug, builder, ok: tie.ok, notSigning: Boolean(tie.notSigning) };
  renderTie();
  renderSigningBanner(tie.notSigning ? true : tie.ok ? false : null);
  hint.className = tie.ok ? 'hint ok' : tie.known ? 'hint bad' : 'hint';
  hint.textContent = tie.text;
}, 450);
form.addEventListener('input', (e) => {
  if (e.target.id === 'nSlug') checkSlug();
  else if (e.target.id === 'nBuilder') { checkBuilder(); renderTie(); }
  renderPreview();
});
// The days the preview showed are read before anything re-renders it, so Open can refuse a field that moved unseen.
form.addEventListener('submit', (e) => { e.preventDefault(); const shown = shownDays; runExclusive(() => openBounty(shown)); });
// A page brought back from the back-forward cache, or a field the browser refilled, is drawn again from the fields.
window.addEventListener('pageshow', () => renderPreview());
// Time to ship: 7 / 14 / 30 days or custom, writing only the days field.
const daysInput = $('#nDays');
const presetButtons = [...document.querySelectorAll('#nDaysPresets [data-days]')];
const pressPreset = (which) => presetButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.days === which)));
presetButtons.forEach((b) => b.addEventListener('click', () => {
  const custom = b.dataset.days === 'custom';
  customDays = custom;
  pressPreset(b.dataset.days);
  $('#nDaysCustom').hidden = !custom;
  if (custom) { daysInput.focus(); daysInput.select(); } else daysInput.value = b.dataset.days;
  renderPreview();
}));
document.querySelectorAll('#nPayoutSeg [data-payout]').forEach((b) => b.addEventListener('click', () => {
  payoutMode = b.dataset.payout === 'intents' ? 'intents' : 'near';
  document.querySelectorAll('#nPayoutSeg [data-payout]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.payout === payoutMode)));
  renderPreview();
}));

/** HEY's signing state for the NEAR escrow, said once at the top of the NEAR view: true = not signing, false = signing. */
function renderSigningBanner(notSigningNow) {
  if (notSigningNow === null) return;
  const el = $('#nSigning');
  el.hidden = !notSigningNow;
  if (notSigningNow) el.innerHTML = '<h2>HEY is not signing for NEAR yet</h2><p>HEY’s attestation route does not sign for escrow.heyresearch.near yet. Until it does, this page opens no NEAR bounty and shows no ship count. Refunds after the deadline never need HEY.</p>';
}

// Project autocomplete: the same ARIA combobox as the Robinhood Chain form, over HEY's public search.
const slugInput = $('#nSlug'), slugList = $('#nSlugList');
let acItems = [], acActive = -1, acAbort = null, acSeq = 0, acDismissed = null;
function acClose() { slugList.hidden = true; slugList.innerHTML = ''; acItems = []; acActive = -1; slugInput.setAttribute('aria-expanded', 'false'); slugInput.removeAttribute('aria-activedescendant'); }
const payChip = (slug) => (!tieCache.get(slug) ? ['', ''] : tieCache.get(slug).payable ? ['ok', 'can be paid'] : ['no', 'not payable yet']);
function acRender() {
  slugList.innerHTML = acItems.map((it, i) => {
    const [cls, word] = payChip(it.slug);
    return `<li role="option" id="nSlugOpt${i}" data-i="${i}" aria-selected="${i === acActive}">${logo(it.logoUrl, it.name)}<span class="txt"><span class="nm"><b>${esc(it.name)}</b><span class="pay ${cls}">${word}</span></span><span class="sl">${esc(it.slug)}</span>${it.status ? `<span class="st">${esc(it.status)}</span>` : ''}</span></li>`;
  }).join('');
  wireLogos(slugList);
  slugList.hidden = !acItems.length;
  slugInput.setAttribute('aria-expanded', String(acItems.length > 0));
  if (acActive >= 0) slugInput.setAttribute('aria-activedescendant', `nSlugOpt${acActive}`); else slugInput.removeAttribute('aria-activedescendant');
}
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
  if (i >= 0) { slugInput.setAttribute('aria-activedescendant', `nSlugOpt${i}`); slugList.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }); acChip(acItems[i].slug); }
  else slugInput.removeAttribute('aria-activedescendant');
}
function acPick(i) { const it = acItems[i]; if (!it) return; slugInput.value = it.slug; acDismissed = it.slug; acClose(); checkSlug(); renderPreview(); }
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
slugList.addEventListener('mousedown', (e) => e.preventDefault());
slugList.addEventListener('click', (e) => { const li = e.target.closest('[role="option"]'); if (li) acPick(Number(li.dataset.i)); });
slugList.addEventListener('mousemove', (e) => { const li = e.target.closest('[role="option"]'); if (li && Number(li.dataset.i) !== acActive) acHighlight(Number(li.dataset.i)); });

// ------------------------------------------------------------------ open (step 1) and fund (step 2)
const MIN_DURATION = 86400, MAX_DURATION = 365 * 86400, DEADLINE_MARGIN = 15 * 60;
async function chainDeadline(days) {
  const base = await chainNow();
  const want = base + days * 86400 + DEADLINE_MARGIN;
  return Math.min(Math.max(want, base + MIN_DURATION + DEADLINE_MARGIN), base + MAX_DURATION);
}
/** The summary a funder confirms before Open signs anything: built from the exact deadline that will be sent. */
function confirmOpen(s) {
  const dlg = $('#nConfirm');
  const zone = localZone();
  const name = esc(s.name);
  dlg.dataset.deadline = String(s.deadline);
  dlg.dataset.days = String(s.days);
  $('#nConfirmLead').innerHTML = `You’re locking <b>${fmt(s.amount)} ${T.symbol}</b> for <b>${name}</b>.`;
  $('#nConfirmBy').innerHTML = `${name} must ship <b>${times(s.minShips)}</b> by <b data-utc>${esc(when(s.deadline))} UTC</b> <span class="muted" data-local>(${esc(when(s.deadline, zone))} in your time zone, ${esc(zone)}).</span>`;
  $('#nConfirmAfter').innerHTML = `Claimable until <b>${esc(when(s.deadline + GRACE))} UTC</b>. If not, funders take it back from <b>${esc(when(s.deadline + GRACE + 1))} UTC</b>.`;
  $('#nConfirmFacts').innerHTML = [
    ['Time to ship', `${s.days} day${s.days === 1 ? '' : 's'} (about ${num((s.deadline - now()) / 86400, 1)} days from now)`],
    ['Paid to', `${ethImplicit(s.builder)}${s.payout === 'intents' ? ' in NEAR Intents' : ' on NEAR'}`],
    ['Deadline sent to the escrow', `${s.deadline} (unix seconds, as your wallet shows it)`],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; if (dlg.open) dlg.close(); resolve(ok); };
    $('#nConfirmYes').onclick = () => done(true);
    $('#nConfirmNo').onclick = () => done(false);
    $('#nConfirmClose').onclick = () => done(false);
    dlg.addEventListener('close', () => done(false), { once: true });
    dlg.showModal();
    $('#nConfirmNo').focus();
  });
}
const CONFIRM_MAX_AGE = 10 * 60; // a summary older than this is refused, never refreshed behind the reader's back
async function openBounty(previewDays = shownDays) {
  const v = readForm();
  if (v.days !== previewDays) { renderPreview(); throw new Error(`The days field holds ${v.days}, not the ${previewDays} the preview showed. Nothing was sent; check Time to ship and press Open bounty again.`); }
  const bad = (id, hintId, msg) => { const h = $(hintId); h.className = 'hint bad'; h.textContent = msg; $(id).scrollIntoView({ behavior: 'smooth', block: 'center' }); return new Error(msg); };
  if (!v.slug) throw bad('#nSlug', '#nSlugHint', 'Type the project’s slug, e.g. predict-fwa.');
  if (!isHeySlug(v.slug)) throw bad('#nSlug', '#nSlugHint', SLUG_FORM_MESSAGE);
  if (!isAddress(v.builder)) throw bad('#nBuilder', '#nBuilderHint', 'Paste the builder’s payout address (0x…).');
  if (v.minShips < 1) throw new Error('A bounty needs at least one ship.');
  if (v.days < 1 || v.days > 365) throw new Error('Time to ship is 1 to 365 days.');
  if (!v.amountOk) throw bad('#nAmount', '#nBalHint', AMOUNT_MESSAGE);
  if ((await readConfig()).retired) throw new Error('The escrow is retired: no new bounty can be opened.');
  const project = await heyProject(v.slug);
  if (!project) throw new Error(`HEY has no published project "${v.slug}".`);
  // Refused, not warned: a bounty HEY will never sign for can only be refunded after its deadline.
  const tie = await builderTie(v.slug, v.builder);
  if (!tie.ok) throw bad('#nBuilder', '#nBuilderHint', tie.text);
  await needWallet();
  const bal = await usdcBalance(account);
  if (v.amount > bal) throw new Error(`You hold ${fmt(bal)} ${T.symbol} on NEAR; lower the amount to lock.`);
  // The deadline is computed once, shown, and that same number is sent: never computed again after the confirmation.
  const deadline = await chainDeadline(v.days);
  const builder = getAddress(v.builder);
  const summary = { ...v, builder, deadline, name: project.name ?? v.slug, shownAt: now() };
  if (!(await confirmOpen(summary))) { toast('Nothing was sent.'); return; }
  const again = readForm();
  if (again.days !== summary.days) throw new Error(`The days field now holds ${again.days}, not the ${summary.days} the summary showed. Nothing was sent; check Time to ship and press Open bounty again.`);
  if (again.slug !== v.slug || !sameHash(again.builder, v.builder) || again.minShips !== v.minShips || again.amount !== v.amount || again.payout !== v.payout) {
    throw new Error('The terms changed after the summary was shown. Nothing was sent; press Open bounty again.');
  }
  if (now() - summary.shownAt > CONFIRM_MAX_AGE) throw new Error('That summary is more than 10 minutes old. Nothing was sent; press Open bounty again for a fresh deadline.');
  const { hash, value } = await sendCall(NEAR.escrow, 'create', { builder, slug: v.slug, min_ships: v.minShips, deadline: summary.deadline, payout: v.payout }, 30n * TGAS, CREATE_DEPOSIT, `Open bounty for ${v.slug} paying ${ethImplicit(builder)}`);
  let id = Number.isInteger(value) ? value : null;
  if (id === null) id = await findMyNewBounty(v.slug, builder).catch(() => null);
  if (id === null) { toast(txDone('Bounty opened. Find it under Bounties, then fund it with Add USDC.', hash)); await load(); return; }
  pendingFund = { id, amount: v.amount, slug: v.slug };
  toast(txDone(`Bounty #${id} opened. Now fund it: step 2 of 2.`, hash));
  renderPreview();
  await load();
  $('#nFundBtn').focus({ preventScroll: true });
}
/** The newest unfunded bounty this account opened for this slug and builder (when the wallet gave no return value). */
async function findMyNewBounty(slug, builder) {
  const count = await view(NEAR.escrow, 'bounty_count');
  const from = Math.max(0, count - 50);
  const page = await view(NEAR.escrow, 'get_bounties', { from_index: from, limit: 50 });
  const hit = [...page].reverse().find((b) => b.creator === account && b.slug === slug && sameHash(b.builder, builder) && b.total === '0' && b.status === 'open');
  return hit ? hit.id : null;
}
/** Fund a bounty with USDC: one ft_transfer_call to the token, with `{"action":"fund","id":N}` for the escrow. */
async function fundBounty(id, amount) {
  if ((await readConfig()).retired) throw new Error('The escrow is retired: no bounty takes more USDC.');
  const b = await view(NEAR.escrow, 'get_bounty', { id });
  if (!b) throw new Error(`There is no bounty #${id}.`);
  if (b.status !== 'open' || (await chainNow()) >= b.deadline) throw new Error('This bounty takes no more USDC: it is claimed or past its deadline.');
  // Asked again now: USDC is added only to a payout HEY ties today.
  const tie = await builderTie(b.slug, getAddress(b.builder));
  if (!tie.ok) throw new Error(tie.known ? `Nothing was sent. ${tie.text}` : 'HEY can’t be reached right now, so nothing was sent. Try again shortly.');
  await needWallet();
  const bal = await usdcBalance(account);
  if (amount > bal) throw new Error(`You hold ${fmt(bal)} ${T.symbol} on NEAR.`);
  const { hash, value } = await sendCall(T.account, 'ft_transfer_call', { receiver_id: NEAR.escrow, amount: amount.toString(), msg: JSON.stringify({ action: 'fund', id }) }, 100n * TGAS, ONE_YOCTO, `Fund bounty #${id} with ${fmt(amount)} ${T.symbol}`);
  // ft_transfer_call answers what the receiver kept: anything less means the escrow refused and the token refunded it.
  if (value !== undefined && value !== null && String(value) !== amount.toString()) {
    throw new Error(`The escrow kept ${fmt(BigInt(String(value) || 0))} of ${fmt(amount)} ${T.symbol}; the token sent the rest back to you.`);
  }
  if (pendingFund?.id === id) pendingFund = null;
  toast(txDone(`Locked ${fmt(amount)} ${T.symbol} in bounty #${id}.`, hash));
  showBalance();
  await load();
}
$('#nFundBtn').addEventListener('click', () => { const p = pendingFund; if (p) runExclusive(() => fundBounty(p.id, p.amount)); });

// ------------------------------------------------------------------ bounties
const MAX_READ = 200;
let rows = [], escrowLocked = null, totalCount = 0, loadSeq = 0;
const claimReady = new Map(); // id -> the verified claim HEY signed, shown before the reader submits it
async function load() {
  const seq = ++loadSeq;
  const box = $('#nBounties');
  const [, count, locked] = await Promise.all([readConfig(), view(NEAR.escrow, 'bounty_count'), usdcBalance(NEAR.escrow).catch(() => null)]);
  if (seq !== loadSeq) return;
  totalCount = Number(count);
  escrowLocked = locked;
  const read = [];
  for (let to = totalCount; to > 0 && read.length < MAX_READ;) {
    const from = Math.max(0, to - 50);
    read.push(...(await view(NEAR.escrow, 'get_bounties', { from_index: from, limit: to - from })).reverse());
    to = from;
  }
  if (seq !== loadSeq) return;
  rows = read.map((b) => ({ ...b, total: BigInt(b.total), paid_out: BigInt(b.paid_out) }));
  renderStats();
  // Funded or settled bounties, and the reader's own empty ones while they can still be funded (step 2).
  const shown = rows.filter((b) => b.total > 0n || b.status !== 'open' || (account && b.creator === account && !retired && now() < b.deadline));
  const hiddenEmpty = rows.length - shown.length;
  $('#nCount').textContent = `${totalCount} bount${totalCount === 1 ? 'y' : 'ies'} on NEAR${hiddenEmpty ? ` · ${hiddenEmpty} with nothing locked not shown` : ''}${totalCount > rows.length ? ` · newest ${rows.length} read` : ''}`;
  if (!shown.length) { box.innerHTML = `<div class="empty">${totalCount ? 'No funded NEAR bounties yet.' : 'No bounties on NEAR yet.'} Open the first one above.</div>`; return; }
  box.innerHTML = shown.map((b) => renderBounty(b, { pending: true })).join('');
  shown.forEach((b) => hydrate(b).catch(() => undefined));
  wireCards(box);
  goToHash();
}
function renderStats() {
  let paid = 0n, open = 0;
  for (const b of rows) {
    paid += b.paid_out;
    if (b.status === 'open' && b.total > 0n && !retired && now() <= b.deadline + GRACE) open++;
  }
  $('#nsLocked').innerHTML = escrowLocked === null ? '—' : `${compact(escrowLocked)}<small>${T.symbol}</small>`;
  $('#nsOpen').textContent = String(open);
  $('#nsPaid').innerHTML = `${compact(paid)}<small>${T.symbol}</small>`;
  $('#nsCount').textContent = String(totalCount);
}
const cardState = new Map(); // id -> { project, mine, att, ships }
async function hydrate(b) {
  const until = Math.min(now() - 120, b.deadline);
  const ask = b.status === 'open' && b.total > 0n && !retired && until >= b.start && now() <= b.deadline + GRACE;
  const [project, mine, att] = await Promise.all([
    heyProject(b.slug).catch(() => null),
    account ? view(NEAR.escrow, 'get_contribution', { id: b.id, account_id: account }).then((v) => BigInt(v)).catch(() => 0n) : 0n,
    ask ? heyAttestation(b.slug, getAddress(b.builder), b.start, until).catch(() => null) : null,
  ]);
  const signed = att?.ok && (await attestationSignedFor(att.body, b.slug, b.builder));
  if (att && !att.ok) renderSigningBanner(notSigning(att) ? true : null);
  else if (signed) renderSigningBanner(false);
  const ships = signed ? await shipTitles(b.slug, att.body.evidenceIds ?? []).catch(() => []) : [];
  cardState.set(b.id, { project, mine, att, signed, ships });
  redraw(b.id);
}
function redraw(id) {
  const b = rows.find((r) => r.id === id);
  const card = document.getElementById(`near-bounty-${id}`);
  if (!b || !card) return;
  const holder = document.createElement('div');
  holder.innerHTML = renderBounty(b, cardState.get(id) ?? { pending: true });
  const next = holder.firstElementChild;
  if (card.classList.contains('hl')) next.classList.add('hl');
  card.replaceWith(next);
  wireCards(next.parentElement ?? document, next);
}
function wireCards(root, only) {
  const scope = only ?? root;
  scope.querySelectorAll('[data-nact]').forEach((el) => {
    el.disabled = busy;
    el.addEventListener('click', () => runExclusive(() => act(el.dataset.nact, Number(el.dataset.id))));
  });
  scope.querySelectorAll('[data-ncopy]').forEach((el) => el.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?chain=near#near-bounty-${el.dataset.ncopy}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); }
  }));
  wireLogos(scope);
}
const KIND = {
  release: 'Release', code: 'Code week', contract_deploy: 'Contract deployed', contract_upgrade: 'Contract upgrade',
  build: 'Build', integration: 'Integration', announcement: 'Entry', contract_source: 'Contract source',
};
function evidenceList(body, ships, max = 5, byDate = false) {
  const ids = Array.isArray(body?.evidenceIds) ? body.evidenceIds : [];
  const urls = Array.isArray(body?.evidenceUrls) ? body.evidenceUrls : [];
  if (!ids.length) return '';
  const byId = new Map(ships.map((s) => [s.id, s]));
  const at = (id) => { const t = Date.parse(byId.get(id)?.recordedAt ?? ''); return Number.isFinite(t) ? t : Infinity; };
  // Each id keeps its own evidence URL; the timeline orders them by the day HEY recorded them, unread dates last.
  const pairs = ids.map((id, i) => [id, urls[i]]);
  if (byDate) pairs.sort((x, y) => at(x[0]) - at(y[0]));
  const items = pairs.slice(0, max).map(([evidenceId, url]) => {
    const s = byId.get(evidenceId);
    const evidence = httpsUrl(url);
    const source = httpsUrl(s?.source);
    const recorded = Date.parse(s?.recordedAt ?? '');
    const when = Number.isFinite(recorded) ? `recorded ${esc(day(recorded / 1000))}` : 'recorded date not read';
    const what = s ? `<b>${esc(KIND[s.kind] ?? s.kind ?? 'Ship')}</b> · ${esc(s.title ?? '')} · <span class="muted">${when}</span>` : `<b>Counted ship</b> · <span class="mono">${esc(String(evidenceId).slice(0, 13))}…</span>`;
    return `<li><span>${what}${evidence ? ` <a href="${esc(evidence)}" target="_blank" rel="noopener">evidence ↗</a>` : ''}${source ? ` <a href="${esc(source)}" target="_blank" rel="noopener">source ↗</a>` : ''}</span></li>`;
  });
  const rest = ids.length > max ? `<li><span>and ${ids.length - max} more</span></li>` : '';
  return `<ul class="ships">${items.join('')}${rest}</ul>`;
}
/** The card's countdown, by the reader's clock: what is left to ship, then to claim, then nothing. */
function countdownParts(deadline, status) {
  const t = now();
  if (status === 'paid') return ['Time left', 'Paid out'];
  if (status !== 'open') return ['Time left', 'Payout pending'];
  if (retired === true) return ['Time left', 'Escrow retired'];
  if (t < deadline) return ['Time left to ship', span(deadline - t)];
  if (t <= deadline + GRACE) return ['Time left to claim', span(deadline + GRACE - t)];
  return ['Time left', 'Closed'];
}
function tickCountdowns() {
  document.querySelectorAll('#nearView [data-ncount]').forEach((el) => {
    const [k, v] = countdownParts(Number(el.dataset.deadline), el.dataset.status);
    const kEl = el.querySelector('.k'), vEl = el.querySelector('.v');
    if (kEl.textContent !== k) kEl.textContent = k;
    if (vEl.textContent !== v) vEl.textContent = v;
  });
}
let ticking = false;
/** Once a minute, on the minute: only the countdown's text changes, in a cell of fixed height. */
function startCountdowns() {
  if (ticking) return;
  ticking = true;
  setTimeout(() => { tickCountdowns(); setInterval(tickCountdowns, 60_000); }, (60 - new Date().getSeconds()) * 1000);
}

/** A ready post for X about one bounty, under 280 characters: the card's own facts, no price. */
const PAGE_URL = 'https://hey-research-lab.github.io/proof-of-ship/';
const cardUrl = (id) => `${PAGE_URL}?chain=near#near-bounty-${id}`;
const X_MAX = 280;
function xText(b, name) {
  const link = cardUrl(b.id);
  const build = (nm) => (b.status === 'paid'
    ? `${nm} shipped ${times(b.ships)} and was paid ${fmt(b.paid_out)} ${T.symbol} on NEAR, released when @HeyResearch counted the ships on chain. #NEARHackathon ${link}`
    : `I'm backing ${nm} on NEAR: ${fmt(b.total)} ${T.symbol} if they ship ${times(b.min_ships)} by ${dayMonth(b.deadline)}. Released only when @HeyResearch counts the ships on chain. #NEARHackathon ${link}`);
  let nm = String(name).replace(/\s+/g, ' ').trim();
  let text = build(nm);
  if (text.length > X_MAX) { nm = `${nm.slice(0, Math.max(1, nm.length - (text.length - X_MAX) - 1))}…`; text = build(nm); }
  return text;
}
const xIntent = (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

function renderBounty(b, hey) {
  const { project = null, mine = 0n, att = null, signed = false, ships = [], pending = false } = hey;
  const need = b.min_ships;
  const graceEnd = b.deadline + GRACE;
  const isRetired = retired === true;
  const open = b.status === 'open';
  const funded = b.total > 0n;
  const inWindow = open && !isRetired && now() <= graceEnd;
  const have = signed ? Number(att.body.attestation.ships) : null;
  const met = have !== null && have >= need;
  let note = '';
  if (open && isRetired) note = 'The escrow was retired by its guardian: this bounty can no longer be claimed or funded, and its funders can take their USDC back now.';
  else if (open && funded && att && !att.ok && notSigning(att)) note = NOT_SIGNING_TEXT;
  else if (open && funded && att?.status === 403) note = 'HEY doesn’t tie this payout address to the project, so it will never sign this claim. Funders can take their USDC back after the deadline plus 3 days.';
  else if (open && funded && att?.status === 404) note = 'HEY has no published project at this slug, so it will not sign a claim for it now.';
  else if (open && funded && att?.ok && !signed) note = 'HEY’s answer is not HEY’s signature for this bounty under the NEAR escrow’s domain, so the page offers no claim.';
  const unavailable = !pending && open && funded && inWindow && !signed && !note && now() >= b.start + 120;
  const state = b.status === 'paid' ? ['ok', 'Paid out']
    : b.status === 'verified' ? ['wait', 'Verified · payout to retry']
    : b.status === 'paying' ? ['wait', 'Paying']
    : isRetired ? ['off', 'Escrow retired · funders can take back']
    : !funded ? (now() < b.deadline ? ['wait', 'Not funded yet · step 2'] : ['off', 'Closed · nothing locked'])
    : att && notSigning(att) ? ['wait', 'HEY not signing for NEAR yet']
    : att?.status === 403 ? ['off', 'Payout address not tied']
    : att?.status === 404 ? ['off', 'Not on HEY · cannot claim now']
    : pending && inWindow ? ['wait', 'Reading HEY…']
    : met && inWindow ? ['ok', 'Target met · ready to release']
    : unavailable ? ['wait', 'HEY count unavailable · try again shortly']
    : now() > graceEnd ? ['off', 'Closed · funders can take back']
    : now() > b.deadline ? ['wait', 'Deadline passed · grace period']
    : ['wait', 'Building'];
  const pct = b.status === 'paid' ? 100 : have === null ? 0 : Math.min(100, Math.round((have / need) * 100));
  const name = project?.name ?? b.slug;
  const acct = b.builder_account;
  const actions = [];
  const ready = claimReady.get(b.id);
  if (met && inWindow && !note && !ready) actions.push(`<button class="go" data-nact="claim" data-id="${b.id}">Release to builder</button>`);
  if (open && !isRetired && now() < b.deadline && !note) actions.push(`<button data-nact="fund" data-id="${b.id}">${funded ? 'Add' : 'Fund with'} ${T.symbol}</button><span class="fund-box" data-nfund-box="${b.id}" hidden><input type="number" inputmode="decimal" min="0" step="any" placeholder="100" aria-label="${T.symbol} to add to bounty #${b.id}"><button class="go" data-nact="fund" data-id="${b.id}">Send</button></span>`);
  if (open && (isRetired || now() > graceEnd) && mine > 0n) actions.push(`<button data-nact="refund" data-id="${b.id}">Take back ${fmt(mine)} ${T.symbol}</button>`);
  if (b.status === 'verified' && !isRetired) actions.push(`<button class="go" data-nact="release" data-id="${b.id}">Retry payout</button>`);
  if (b.status === 'verified' && b.payout === 'intents' && b.failed_payouts > 0) actions.push(`<button data-nact="release-direct" data-id="${b.id}">Pay to the NEAR account instead</button>`);
  const postable = b.status === 'paid' || (open && funded && !isRetired && now() < b.deadline);
  if (postable) actions.push(`<a class="link-btn" data-nx="${b.id}" href="${esc(xIntent(xText(b, name)))}" target="_blank" rel="noopener">Post on X</a>`);
  actions.push(`<button class="link-btn" type="button" data-ncopy="${b.id}">Copy link</button>`);
  const progressLabel = b.status === 'paid' ? `Paid ${fmt(b.paid_out)} ${T.symbol} on ${b.ships} ships HEY counted` : have === null ? 'Ships HEY counted' : `HEY counts ${have} of ${need} ships`;
  const claimBox = ready ? `<div class="claimbox" role="region" aria-label="Claim for bounty #${b.id}">
      <p class="ok"><b>HEY counts ${ready.ships} ship${ready.ships === 1 ? '' : 's'}</b> for ${esc(name)} from ${esc(day(ready.since))} to ${esc(day(ready.until))}. The bounty needs ${need}.</p>
      <p class="muted">Signed by HEY’s attester ${esc(short(NEAR.attester))}: checked on this page, and by the escrow itself (<span class="mono">recover_signer</span> answered <span class="mono">is_attester: true</span>). The payout goes to <span class="mono">${esc(acct)}</span>${b.payout === 'intents' ? ' in NEAR Intents' : ''}, fixed by the signature, whoever submits it.</p>
      ${evidenceList(ready.body, ready.titles, 8)}
      <div class="actions"><button class="go" data-nact="confirm-claim" data-id="${b.id}">Submit the claim</button><button data-nact="cancel-claim" data-id="${b.id}">Cancel</button><span class="mono">${b.payout === 'intents' ? '200 TGas' : `150 TGas · ${formatNear(config?.token_storage_deposit)} NEAR storage, returned if not needed`}</span></div>
    </div>` : '';
  const counted = signed && !ready ? evidenceList(att.body, ships, 10, true) : '';
  const list = counted ? `<div class="counted"><div class="k">Ships HEY has counted so far, ${have} since ${esc(day(b.start))}</div>${counted}</div>` : '';
  const [leftK, leftV] = countdownParts(b.deadline, b.status);
  return `<article class="card bounty" id="near-bounty-${b.id}"${pending ? ' data-pending="1"' : ''}>
    <div class="top">
      <div class="id">${logo(project?.logoUrl, name)}<div><span class="name">${esc(name)}</span><a class="slug" href="${NEAR.hey}/project/${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">heyresearch.xyz/project/${esc(b.slug)}</a></div></div>
      <span class="chip ${state[0]}">${esc(state[1])}</span>
    </div>
    <div class="facts">
      <div class="fact"><div class="k">Locked</div><div class="v">${fmt(b.total)} ${T.symbol}</div></div>
      <div class="fact left" data-ncount data-deadline="${b.deadline}" data-status="${esc(b.status)}"><div class="k">${esc(leftK)}</div><div class="v">${esc(leftV)}</div></div>
      <div class="fact"><div class="k">Payout</div><div class="v">${b.payout === 'intents' ? 'NEAR Intents' : 'NEAR account'}</div></div>
      <div class="fact"><div class="k">Pays</div><div class="v"><a class="mono" href="${esc(accountUrl(acct))}" target="_blank" rel="noopener">${esc(short(acct))}</a></div></div>
    </div>
    <dl class="when">
      <div><dt>Ship by</dt><dd data-when="ship">${esc(utcShort(b.deadline))}</dd></div>
      <div><dt>Claim until</dt><dd data-when="claim">${esc(utcShort(graceEnd))}</dd></div>
      <div><dt>Refunds from</dt><dd data-when="refund">${esc(utcShort(graceEnd + 1))}</dd></div>
    </dl>
    <div class="progress">
      <div class="lbl"><span>${esc(progressLabel)}</span><span>${b.status === 'paid' ? '' : `target ${need}`}</span></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${have ?? 0}"><i style="width:${pct}%"></i></div>
    </div>
    ${note ? `<p class="hint bad" style="margin:0">${esc(note)}</p>` : claimBox || list || (b.status !== 'open' || pending || !funded ? '' : '<p class="hint" style="margin:0">No counted ships since the bounty opened yet.</p>')}
    <div class="actions">${actions.join('')}<span class="mono">#${b.id} · opened ${day(b.start)} by ${esc(short(b.creator))}${mine > 0n ? ` · you locked ${fmt(mine)} ${T.symbol}` : ''}</span></div>
  </article>`;
}
const formatNear = (yocto) => { try { return num(Number(BigInt(yocto ?? 0)) / Number(YOCTO_PER_NEAR), 5); } catch { return '0.00125'; } };

/** Fetch HEY's count for a bounty and check everything the escrow will check, then show it before anything is sent. */
async function prepareClaim(id) {
  if ((await readConfig()).retired) throw new Error('The escrow is retired: claims are off, refunds are open.');
  const b = await view(NEAR.escrow, 'get_bounty', { id });
  if (!b) throw new Error(`There is no bounty #${id}.`);
  const t = await chainNow();
  if (b.status !== 'open') throw new Error('This bounty was already claimed.');
  if (t > b.deadline + GRACE) throw new Error('The claim window (deadline plus 3 days) has closed.');
  if (BigInt(b.total) === 0n) throw new Error('Nothing is locked in this bounty yet.');
  toast('Asking HEY to sign the ship count for NEAR…', true);
  const res = await heyAttestation(b.slug, getAddress(b.builder), b.start, Math.min(now() - 120, b.deadline));
  if (!res.ok) throw new Error(notSigning(res) ? NOT_SIGNING_TEXT : String(res.body?.message ?? `HEY answered ${res.status}.`));
  const a = res.body.attestation;
  if (!(await attestationSignedFor(res.body, b.slug, b.builder))) throw new Error('HEY’s answer is not HEY’s signature for this bounty under the NEAR escrow’s domain; nothing was sent.');
  if (Number(a.since) !== b.start) throw new Error('HEY’s count starts at a different time than this bounty; nothing was sent.');
  if (Number(a.until) > b.deadline) throw new Error('HEY’s count runs past this bounty’s deadline; nothing was sent.');
  if (Number(a.ships) < b.min_ships) throw new Error(`HEY counts ${a.ships} ships; the bounty needs ${b.min_ships}.`);
  const attestation = { project: a.project, builder: a.builder, since: a.since, until: a.until, ships: a.ships, evidence: a.evidence, issuedAt: a.issuedAt };
  // The escrow's own dry run of the signature half of `claim`: what it recovers is what it will accept.
  const signer = await view(NEAR.escrow, 'recover_signer', { attestation, signature: res.body.signature });
  if (!signer?.is_attester) throw new Error(`The escrow does not recover HEY’s attester from this signature (${signer?.error ?? signer?.signer ?? 'no signer'}); nothing was sent.`);
  const titles = await shipTitles(b.slug, res.body.evidenceIds ?? []).catch(() => []);
  claimReady.set(id, { attestation, signature: res.body.signature, ships: Number(a.ships), since: Number(a.since), until: Number(a.until), body: res.body, titles });
  toast('');
  redraw(id);
  document.querySelector(`#near-bounty-${id} [data-nact="confirm-claim"]`)?.focus();
}
async function submitClaim(id) {
  const ready = claimReady.get(id);
  if (!ready) throw new Error('Check HEY’s count first.');
  if (now() - Number(ready.attestation.issuedAt) > 82_800) { claimReady.delete(id); redraw(id); throw new Error('HEY’s signature is nearly a day old; press Release to builder again for a fresh one.'); }
  const b = rows.find((r) => r.id === id);
  const intents = b?.payout === 'intents';
  const deposit = intents ? 0n : BigInt(config?.token_storage_deposit ?? '1250000000000000000000');
  const { hash, value } = await sendCall(NEAR.escrow, 'claim', { id, attestation: ready.attestation, signature: ready.signature }, (intents ? 200n : 150n) * TGAS, deposit, `Release bounty #${id}`);
  claimReady.delete(id);
  toast(txDone(value === false ? 'HEY’s count was accepted, but the payout did not go through yet: anyone can press Retry payout.' : `Released: bounty #${id} paid ${b ? `${fmt(b.total)} ${T.symbol} ` : ''}to ${b ? b.builder_account : 'the builder'}.`, hash));
  await load();
}
async function act(kind, id) {
  if (kind === 'fund') {
    const box = document.querySelector(`[data-nfund-box="${id}"]`);
    if (box && box.hidden) { box.hidden = false; box.querySelector('input')?.focus(); return; }
    const amount = parseAmount(box?.querySelector('input')?.value);
    if (amount === null) throw new Error(`Enter how much ${T.symbol} to add, as a plain number above 0.`);
    await fundBounty(id, amount);
  } else if (kind === 'claim') await prepareClaim(id);
  else if (kind === 'confirm-claim') await submitClaim(id);
  else if (kind === 'cancel-claim') { claimReady.delete(id); redraw(id); }
  else if (kind === 'refund') {
    const { hash } = await sendCall(NEAR.escrow, 'refund', { id }, 50n * TGAS, 0n, `Take back from bounty #${id}`);
    toast(txDone('Refunded: your USDC is back in your NEAR account.', hash));
    showBalance();
    await load();
  } else if (kind === 'release' || kind === 'release-direct') {
    const b = rows.find((r) => r.id === id);
    const direct = kind === 'release-direct';
    const viaIntents = b?.payout === 'intents' && !direct;
    const deposit = viaIntents ? 0n : BigInt(config?.token_storage_deposit ?? '1250000000000000000000');
    const { hash, value } = await sendCall(NEAR.escrow, 'release', direct ? { id, direct: true } : { id }, (viaIntents ? 200n : 150n) * TGAS, deposit, `Retry the payout of bounty #${id}`);
    toast(txDone(value === false ? 'The payout did not go through again; try later.' : 'Payout sent.', hash));
    await load();
  }
}
function goToHash() {
  const m = /^#near-bounty-(\d{1,9})$/.exec(location.hash);
  const card = m ? document.getElementById(`near-bounty-${m[1]}`) : null;
  if (!card || card.dataset.seen) return;
  card.dataset.seen = '1';
  card.scrollIntoView({ block: 'start' });
  card.classList.add('hl');
  setTimeout(() => document.getElementById(card.id)?.classList.remove('hl'), 2400);
}

// ------------------------------------------------------------------ start
$('#nConnect').addEventListener('click', () => openPicker());
$('#nConnect').addEventListener('pointerenter', () => { if (!testWallet()) loadSelector().catch(() => undefined); }, { once: true });
$('#nearWalletsClose').addEventListener('click', () => $('#nearWallets').close());
$('#nAccount').addEventListener('click', (e) => { e.stopPropagation(); $('#nAccountMenu').hidden = !$('#nAccountMenu').hidden; });
document.addEventListener('click', (e) => { if (!$('#nAccountMenu').hidden && !e.target.closest('#nAccountMenu')) $('#nAccountMenu').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#nAccountMenu').hidden = true; });
$('#nAcctCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(account); toast('Account copied.'); } catch { toast(account); } });
$('#nAcctDisconnect').addEventListener('click', () => disconnect().catch(fail));
/**
 * Whether HEY signs for the NEAR escrow at all, asked once with an address HEY ties to nothing: the route checks the
 * escrow before the project and the payout, so a 403 or 404 means the escrow was accepted, and a 400 about the escrow
 * or a 503 means it is not signing. Nothing it answers can be used: no signature comes back for an untied address.
 */
async function probeSigning() {
  const t = now() - 120;
  const res = await heyAttestation('predict-fwa', '0x0000000000000000000000000000000000000001', t - 60, t).catch(() => null);
  if (!res) return;
  if (notSigning(res)) renderSigningBanner(true);
  else if (res.status === 403 || res.status === 404) renderSigningBanner(false);
}
/** The escrow account's full-access keys, read live: none means nobody, HEY included, can redeploy its code. */
async function renderKeys() {
  const r = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: NEAR.escrow });
  const full = (r?.keys ?? []).filter((k) => k?.access_key?.permission === 'FullAccess').length;
  $('#nKeys').textContent = full === 0
    ? 'Its account holds no full-access key (read from NEAR just now), so nobody, HEY included, can redeploy its code.'
    : `Its account still holds ${full} full-access key${full === 1 ? '' : 's'} (read from NEAR just now): until the operator deletes ${full === 1 ? 'it' : 'them'}, trust the operator as well as the code.`;
}
async function start() {
  renderContract();
  renderKeys().catch(() => { $('#nKeys').textContent = 'Its access keys could not be read just now.'; });
  renderPreview();
  startCountdowns();
  probeSigning().catch(() => undefined);
  await restoreWallet().catch(() => undefined);
  if (!account) await load();
}
setChain(chainFromUrl(), false);
