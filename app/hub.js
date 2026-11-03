import { createPublicClient, decodeEventLog, domainSeparator, formatUnits, getAddress, hashTypedData, http, isAddress, keccak256, recoverAddress, stringToBytes } from './vendor/viem.js?v=9';
import { CONFIG } from './config.js?v=8';
import { NEAR } from './near-config.js?v=1';
import { badge, setFilter, setOrder, statsOf } from './lib.js?v=1';

/*
 * The overview both chains share: the live diagram, the figures of both escrows side by side, the one list's filter
 * and order, the activity feed, the project view (?project=<slug>) and the receipt checker. It reads the two
 * contracts and HEY's public API; it never signs or sends anything.
 */
const framed = (() => { try { return window.top !== window.self; } catch { return true; } })();
if (framed) throw new Error('Proof of Ship does not run inside a frame.');

// ------------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const amount = (v, decimals) => num(formatUnits(BigInt(v), decimals));
const compact = (v, decimals) => {
  const x = Number(formatUnits(BigInt(v), decimals));
  return x >= 1e6 ? `${num(x / 1e6, 2)}M` : x >= 1e4 ? `${num(x / 1e3, 1)}K` : num(x);
};
const short = (a) => (String(a).length > 14 ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : String(a));
const now = () => Math.floor(Date.now() / 1000);
const pad2 = (x) => String(x).padStart(2, '0');
const day = (s) => new Date(Number(s) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const stamp = (s) => { const d = new Date(Number(s) * 1000); return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; };
const httpsUrl = (url) => { try { const u = new URL(String(url)); return u.protocol === 'https:' ? u.href : null; } catch { return null; } };
const initial = (name) => (String(name ?? '').match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
const logo = (url, name) => httpsUrl(url)
  ? `<img src="${esc(httpsUrl(url))}" alt="" loading="lazy" referrerpolicy="no-referrer" data-logo data-initial="${esc(initial(name))}">`
  : `<span class="ph" aria-hidden="true">${esc(initial(name))}</span>`;
function wireLogos(root) {
  root.querySelectorAll('img[data-logo]').forEach((img) => {
    const swap = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'ph', textContent: img.dataset.initial ?? '' }));
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  });
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const PAGE_URL = 'https://hey-research-lab.github.io/proof-of-ship/';
let toastTimer;
const toast = (msg) => { clearTimeout(toastTimer); const el = $('#toast'); el.textContent = msg; toastTimer = setTimeout(() => { el.textContent = ''; }, 5000); };

// ------------------------------------------------------------------ the two chains, read only
const chain = { id: CONFIG.chainId, name: CONFIG.chainName, nativeCurrency: { name: 'Ether', symbol: CONFIG.nativeSymbol, decimals: 18 }, rpcUrls: { default: { http: [CONFIG.rpc] } } };
const pub = createPublicClient({ chain, transport: http(CONFIG.rpc) });
const abiPromise = fetch('./ShipEscrow.abi.json?v=6').then((r) => r.json());
const utf8 = new TextEncoder();
const b64 = (s) => { let bin = ''; for (const byte of utf8.encode(s)) bin += String.fromCharCode(byte); return btoa(bin); };
async function nearRpc(method, params) {
  let last = null;
  for (const url of NEAR.rpcs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hub', method, params }) });
      if (!r.ok) { last = new Error(`NEAR RPC answered ${r.status}.`); continue; }
      const j = await r.json();
      if (j?.error) { last = new Error(String(j.error?.data ?? j.error?.message ?? 'NEAR RPC error')); continue; }
      return j.result;
    } catch { last = new Error('NEAR RPC could not be reached.'); }
  }
  throw last ?? new Error('NEAR RPC could not be reached.');
}
async function nearView(method, args = {}) {
  const res = await nearRpc('query', { request_type: 'call_function', finality: 'final', account_id: NEAR.escrow, method_name: method, args_base64: b64(JSON.stringify(args)) });
  if (res?.error) throw new Error(String(res.error));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

/** The two signing domains, exactly as each escrow builds them (src/ShipEscrow.sol, the NEAR contract's new()). */
const RH_DOMAIN = { name: 'HEY Proof of Ship', version: '1', chainId: CONFIG.chainId, verifyingContract: getAddress(CONFIG.escrow) };
const NEAR_SALT = keccak256(stringToBytes(NEAR.escrow));
const NEAR_DOMAIN = { name: 'HEY Proof of Ship', version: '1', chainId: NEAR.chainId, salt: NEAR_SALT };
const SHIPS_TYPES = {
  Ships: [
    { name: 'project', type: 'bytes32' }, { name: 'builder', type: 'address' }, { name: 'since', type: 'uint64' },
    { name: 'until', type: 'uint64' }, { name: 'ships', type: 'uint32' }, { name: 'evidence', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
};

// ------------------------------------------------------------------ the diagram, read live
/*
 * The attester each escrow was deployed with and the domain separator each one computes, read from the contracts and
 * set beside what this page computes from the domain: two different separators for one key.
 */
async function readDiagram() {
  const ABI = await abiPromise;
  const [rh, near] = await Promise.allSettled([
    Promise.all(['attester', 'domainSeparator'].map((functionName) => pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName }))),
    nearView('get_config'),
  ]);
  const rhSep = domainSeparator({ domain: RH_DOMAIN });
  const nearSep = domainSeparator({ domain: NEAR_DOMAIN });
  // The escrow's own separator beside the one this page computes from the domain: a tick when they are the same.
  const sepLine = (onChain, mine) => `<span title="${esc(onChain)}">${esc(short(String(onChain)))}</span> <span class="${sameHash(onChain, mine) ? 'ok' : 'bad'}" title="${sameHash(onChain, mine) ? 'The escrow’s own separator is the one this page computes from the domain' : 'The escrow’s separator differs from the domain shown'}">${sameHash(onChain, mine) ? '✓' : '✗'}</span>`;
  const lines = [];
  if (rh.status === 'fulfilled') {
    const [att, sep] = rh.value;
    $('#fRhSep').innerHTML = sepLine(sep, rhSep);
    lines.push(`<span class="${sameHash(att, CONFIG.attester) ? 'ok' : 'bad'}">${sameHash(att, CONFIG.attester) ? '✓' : '✗'}</span> ShipEscrow’s <span class="mono">attester()</span>`);
  } else { $('#fRhSep').innerHTML = `<span title="${esc(rhSep)}">${esc(short(rhSep))}</span> <span class="muted">not read</span>`; lines.push('ShipEscrow not read just now'); }
  if (near.status === 'fulfilled') {
    const c = near.value;
    $('#fNearSep').innerHTML = sepLine(String(c.domain_separator), nearSep);
    const ok = sameHash(c.attester, NEAR.attester) && sameHash(c.salt, NEAR_SALT) && Number(c.chain_id) === NEAR.chainId;
    lines.push(`<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span> the NEAR escrow’s <span class="mono">get_config</span>`);
  } else { $('#fNearSep').innerHTML = `<span title="${esc(nearSep)}">${esc(short(nearSep))}</span> <span class="muted">not read</span>`; lines.push('the NEAR escrow not read just now'); }
  $('#fAttesterLive').innerHTML = `Named by ${lines.join(' and ')}: one key, two domains.`;
}

// ------------------------------------------------------------------ figures, both chains
const unitV = (v, d, sym) => `${compact(v, d)}<small>${sym}</small>`;
function renderFigures() {
  const rh = statsOf('robinhood'), nr = statsOf('near');
  const known = (s, k) => s && !s.failed && s[k] !== null && s[k] !== undefined;
  const put = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const notRead = (s) => (s?.failed ? 'not read' : '…');
  put('sCount', known(rh, 'count') ? String(rh.count) : notRead(rh));
  put('sBuilders', known(rh, 'builders') ? String(rh.builders.length) : notRead(rh));
  put('nsBuilders', known(nr, 'builders') ? String(nr.builders.length) : notRead(nr));
  if (nr?.failed) { for (const id of ['nsCount', 'nsOpen', 'nsLocked', 'nsPaid']) put(id, 'not read'); }
  if (rh?.failed) { for (const id of ['sOpen', 'sLocked', 'sPaid', 'sBurned']) put(id, 'not read'); }
  const both = (k) => known(rh, k) && known(nr, k);
  put('tCount', both('count') ? String(rh.count + nr.count) : '…');
  put('tOpen', both('open') ? String(rh.open + nr.open) : '…');
  // WIF and USDC are different units: shown one above the other, never added into one figure.
  const pair = (k) => `<span>${known(rh, k) ? unitV(rh[k], rh.decimals, 'WIF') : '…'}</span><span>${known(nr, k) ? unitV(nr[k], nr.decimals, 'USDC') : '…'}</span>`;
  put('tLocked', pair('locked'));
  put('tPaid', pair('paid'));
  put('tBurned', known(rh, 'burned') ? unitV(rh.burned, rh.decimals, 'WIF') : '…');
  // A builder paid on both chains with the same address is one builder.
  put('tBuilders', both('builders') ? String(new Set([...rh.builders, ...nr.builders].map((a) => a.toLowerCase())).size) : '…');
  const live = (s, sym) => (s?.failed ? 'Not read just now.' : !s ? 'Reading the escrow…'
    : `<b>${s.count}</b> bount${s.count === 1 ? 'y' : 'ies'} · <b>${s.locked === null || s.locked === undefined ? 'not read' : `${amount(s.locked, s.decimals)} ${sym}`}</b> locked now`);
  $('#fRhLive').innerHTML = live(rh, 'WIF');
  $('#fNearLive').innerHTML = live(nr, 'USDC');
}
document.addEventListener('pos:stats', renderFigures);

// ------------------------------------------------------------------ the list: filter and date order
const urlShow = new URLSearchParams(location.search).get('show');
document.querySelectorAll('#filter [data-show]').forEach((b) => b.addEventListener('click', () => setFilter({ chain: b.dataset.show })));
document.querySelectorAll('#order [data-order]').forEach((b) => b.addEventListener('click', () => {
  setOrder(b.dataset.order);
  document.querySelectorAll('#order [data-order]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));

// ------------------------------------------------------------------ HEY reads
const projects = new Map();
async function heyProject(slug) {
  if (projects.has(slug)) return projects.get(slug);
  const p = fetch(`${CONFIG.hey}/api/projects/${encodeURIComponent(slug)}`).then(async (r) => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HEY answered ${r.status}`);
    const j = await r.json();
    return j.project ?? j;
  });
  projects.set(slug, p);
  p.catch(() => projects.delete(slug));
  return p;
}
async function heyShips(slug, since, until) {
  const u = new URL(`${CONFIG.hey}/api/v1/proof-of-ship/ships`);
  u.searchParams.set('slug', slug); u.searchParams.set('since', String(since)); u.searchParams.set('until', String(until));
  const r = await fetch(u);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || typeof j !== 'object') throw new Error(String(j?.message ?? `HEY answered ${r.status}`));
  return j;
}
async function shipTitles(slug, ids) {
  const want = new Set(ids);
  if (!want.size) return [];
  const r = await fetch(`${CONFIG.hey}/api/projects/${encodeURIComponent(slug)}/timeline?limit=200`).catch(() => null);
  if (!r?.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.items ?? []).filter((it) => want.has(it.id));
}
const KIND = {
  release: 'Release', code: 'Code week', contract_deploy: 'Contract deployed', contract_upgrade: 'Contract upgrade',
  build: 'Build', integration: 'Integration', announcement: 'Entry', contract_source: 'Contract source',
};

// ------------------------------------------------------------------ activity feed
/*
 * Robinhood Chain: the escrow's own events, read with eth_getLogs over public RPC from its deploy block. NEAR: the
 * escrow's transactions and their NEP-297 events from FastNear's public transactions API; when that cannot be read,
 * the opening dates from the escrow's own state, each linked to the escrow's page on nearblocks (never a made-up hash).
 */
const TX_EVM = /^0x[0-9a-fA-F]{64}$/;
const TX_NEAR = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
async function rhActivity() {
  const ABI = await abiPromise;
  const head = await pub.getBlockNumber();
  const logs = [];
  let span = 2_000_000n, requests = 0;
  for (let from = CONFIG.escrowFromBlock; from <= head;) {
    if (++requests > 60) throw new Error('Too many log reads.');
    const to = from + span - 1n > head ? head : from + span - 1n;
    let page;
    // No topic filter: Robinhood Chain's node allows 2,000,000 blocks a request without one, 100,000 with a list of
    // event topics. The escrow's logs are few, so they are read whole and decoded here.
    try { page = await pub.getLogs({ address: CONFIG.escrow, fromBlock: from, toBlock: to }); } catch (e) {
      if (span <= 10_000n) throw e;
      span /= 2n;
      continue;
    }
    for (const log of page) {
      if (log.removed) continue;
      try { logs.push({ ...log, ...decodeEventLog({ abi: ABI, data: log.data, topics: log.topics }) }); } catch { /* not one of the escrow's events */ }
    }
    from = to + 1n;
  }
  const slugs = new Map(), decimals = CONFIG.token.decimals;
  for (const l of logs) if (l.eventName === 'BountyCreated') slugs.set(String(l.args.id), { slug: l.args.slug, minShips: Number(l.args.minShips), deadline: Number(l.args.deadline) });
  const blocks = [...new Set(logs.map((l) => l.blockNumber))].slice(-80);
  const times = new Map(await Promise.all(blocks.map(async (n) => [n, Number((await pub.getBlock({ blockNumber: n })).timestamp)])));
  const out = [];
  for (const l of logs) {
    if (!TX_EVM.test(String(l.transactionHash)) || l.removed) continue;
    const id = Number(l.args.id);
    const base = { chain: 'robinhood', id, at: times.get(l.blockNumber) ?? null, order: Number(l.logIndex ?? 0), href: `${CONFIG.explorer}/tx/${l.transactionHash}`, linkText: 'tx', slug: slugs.get(String(id))?.slug ?? null };
    if (l.eventName === 'BountyCreated') out.push({ ...base, kind: 'opened', text: `${Number(l.args.minShips)} ship${Number(l.args.minShips) === 1 ? '' : 's'} by ${day(l.args.deadline)}` });
    else if (l.eventName === 'Funded') out.push({ ...base, kind: 'funded', text: `${amount(l.args.amount, decimals)} WIF locked` });
    else if (l.eventName === 'Claimed') out.push({ ...base, kind: 'released', text: `${amount(l.args.paid, decimals)} WIF to the builder${l.args.burned > 0n ? `, ${amount(l.args.burned, decimals)} burned` : ''} · ${l.args.ships} ships counted` });
    else if (l.eventName === 'Refunded') out.push({ ...base, kind: 'refunded', text: `${amount(l.args.amount, decimals)} WIF back to a backer` });
  }
  return { items: out };
}
const TXAPI = 'https://tx.main.fastnear.com';
const NEAR_EVENTS = { bounty_created: 'opened', funded: 'funded', claimed: 'released', refunded: 'refunded' };
async function nearActivity() {
  const dec = NEAR.token.decimals;
  const fromState = async (why) => {
    const count = Number(await nearView('bounty_count'));
    const read = [];
    for (let to = count; to > 0 && read.length < 200;) { const from = Math.max(0, to - 50); read.push(...(await nearView('get_bounties', { from_index: from, limit: to - from }))); to = from; }
    const page = `${NEAR.explorer}/address/${NEAR.escrow}`;
    return {
      items: read.map((b) => ({ chain: 'near', id: b.id, slug: b.slug, kind: 'opened', at: Number(b.start), order: 0, href: page, linkText: 'escrow', text: `${b.min_ships} ship${b.min_ships === 1 ? '' : 's'} by ${day(b.deadline)}` })),
      note: why,
    };
  };
  let hashes;
  try {
    const r = await fetch(`${TXAPI}/v0/account`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id: NEAR.escrow }) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    hashes = (Array.isArray(j?.account_txs) ? j.account_txs : []).filter((t) => TX_NEAR.test(String(t?.transaction_hash)) && t.is_success !== false).slice(0, 80);
  } catch { return fromState('NEAR transaction hashes could not be read just now: NEAR bounties show when they opened, from the escrow’s own state, each linked to the escrow on nearblocks.'); }
  const at = new Map(hashes.map((t) => [t.transaction_hash, Number(BigInt(String(t.tx_block_timestamp ?? '0')) / 1_000_000_000n) || null]));
  const out = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const r = await fetch(`${TXAPI}/v0/transactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx_hashes: hashes.slice(i, i + 20).map((t) => t.transaction_hash) }) }).catch(() => null);
    const j = r?.ok ? await r.json().catch(() => null) : null;
    if (!j) return fromState('NEAR transactions could not be read just now: NEAR bounties show when they opened, from the escrow’s own state.');
    for (const t of Array.isArray(j.transactions) ? j.transactions : []) {
      const hash = t?.transaction?.hash;
      if (!TX_NEAR.test(String(hash))) continue;
      let n = 0;
      for (const rc of Array.isArray(t.receipts) ? t.receipts : []) {
        if (rc?.receipt?.receiver_id !== NEAR.escrow) continue;
        for (const log of rc?.execution_outcome?.outcome?.logs ?? []) {
          if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
          let ev; try { ev = JSON.parse(log.slice(11)); } catch { continue; }
          if (ev?.standard !== 'hey-proof-of-ship' || !NEAR_EVENTS[ev.event]) continue;
          for (const d of Array.isArray(ev.data) ? ev.data : []) {
            const base = { chain: 'near', id: Number(d.id), kind: NEAR_EVENTS[ev.event], at: at.get(hash) ?? null, order: n++, href: `${NEAR.explorer}/txns/${hash}`, linkText: 'tx', slug: typeof d.slug === 'string' ? d.slug : null };
            if (ev.event === 'bounty_created') out.push({ ...base, text: `${d.min_ships} ship${d.min_ships === 1 ? '' : 's'} by ${day(d.deadline)}` });
            else if (ev.event === 'funded') out.push({ ...base, text: `${amount(d.amount, dec)} USDC locked` });
            else if (ev.event === 'claimed') out.push({ ...base, text: `${amount(d.paid, dec)} USDC to the builder${d.route === 'intents' ? ' in NEAR Intents' : ''} · ${d.ships} ships counted` });
            else if (ev.event === 'refunded') out.push({ ...base, text: `${amount(d.amount, dec)} USDC back to a funder` });
          }
        }
      }
    }
  }
  // Slugs for events that carry only an id, from the bounty_created events or the escrow's state.
  const slugs = new Map(out.filter((e) => e.slug).map((e) => [e.id, e.slug]));
  if (out.some((e) => !slugs.has(e.id))) {
    const count = Number(await nearView('bounty_count').catch(() => 0));
    const page = count ? await nearView('get_bounties', { from_index: Math.max(0, count - 50), limit: 50 }).catch(() => []) : [];
    for (const b of page) if (!slugs.has(b.id)) slugs.set(b.id, b.slug);
  }
  for (const e of out) e.slug ??= slugs.get(e.id) ?? null;
  return { items: out };
}
const KIND_WORDS = { opened: 'Opened', funded: 'Funded', released: 'Released', refunded: 'Refunded' };
let feed = [], feedShown = 12;
async function renderFeed() {
  const list = $('#feedList');
  const items = feed.slice(0, feedShown);
  const names = new Map();
  await Promise.all([...new Set(items.map((e) => e.slug).filter((s) => s && SLUG_RE.test(s)))].slice(0, 12).map(async (s) => { const p = await heyProject(s).catch(() => null); if (p?.name) names.set(s, p.name); }));
  list.innerHTML = items.length ? items.map((e) => {
    const card = e.chain === 'near' ? `#near-bounty-${e.id}` : `#bounty-${e.id}`;
    const who = e.slug ? esc(names.get(e.slug) ?? e.slug) : 'a bounty';
    return `<li data-kind="${e.kind}" data-on="${e.chain}"><span class="kind">${KIND_WORDS[e.kind]}</span><span class="what">${badge(e.chain)}<a href="${card}"><b>#${e.id} ${who}</b></a><span>${esc(e.text)}</span></span><span class="at">${e.at ? `<time datetime="${new Date(e.at * 1000).toISOString()}">${stamp(e.at)}</time>` : '<span>time not read</span>'}<a href="${esc(e.href)}" target="_blank" rel="noopener">${e.linkText === 'tx' ? 'transaction ↗' : 'on nearblocks ↗'}</a></span></li>`;
  }).join('') : '<li><span class="muted">No activity read yet.</span></li>';
  $('#feedMore').hidden = feed.length <= feedShown;
}
async function loadFeed() {
  const [rh, nr] = await Promise.allSettled([rhActivity(), nearActivity()]);
  const notes = [];
  feed = [];
  if (rh.status === 'fulfilled') feed.push(...rh.value.items); else notes.push('Robinhood Chain activity could not be read just now.');
  if (nr.status === 'fulfilled') { feed.push(...nr.value.items); if (nr.value.note) notes.push(nr.value.note); } else notes.push('NEAR activity could not be read just now.');
  // Newest first; an event whose time was not read goes last. Same time: later in the transaction first.
  feed.sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || b.order - a.order);
  $('#feedNote').textContent = notes.join(' ');
  await renderFeed();
}
$('#feedMore').addEventListener('click', () => { feedShown += 12; renderFeed().catch(() => undefined); });

// ------------------------------------------------------------------ verify a receipt
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const check = (ok, html) => `<li data-ok="${ok}"><span>${html}</span></li>`;
/** What a pasted attestation proves: recomputed here, never taken from the JSON's own claims. */
async function verifyReceipt(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, head: 'Not JSON', checks: [check(false, 'Paste the whole answer of HEY’s attestation route, as JSON.')] }; }
  const a = obj?.attestation ?? obj?.typedData?.message ?? obj?.message;
  const d = obj?.domain ?? obj?.typedData?.domain;
  const signature = obj?.signature;
  if (!a || typeof a !== 'object' || !d || typeof d !== 'object' || typeof signature !== 'string') {
    return { ok: false, head: 'Not a HEY attestation', checks: [check(false, 'It needs <b>attestation</b> (or <b>typedData.message</b>), <b>domain</b> (or <b>typedData.domain</b>) and <b>signature</b>.')] };
  }
  const checks = [];
  let message;
  try {
    if (!BYTES32.test(String(a.project)) || !BYTES32.test(String(a.evidence)) || !isAddress(String(a.builder))) throw new Error('shape');
    message = { project: a.project, builder: getAddress(a.builder), since: BigInt(a.since), until: BigInt(a.until), ships: Number(a.ships), evidence: a.evidence, issuedAt: BigInt(a.issuedAt ?? a.issued_at) };
    if (!Number.isInteger(message.ships) || message.ships < 0) throw new Error('shape');
  } catch { return { ok: false, head: 'Not a HEY attestation', checks: [check(false, 'The attestation’s fields are not a <b>Ships</b> record: project, builder, since, until, ships, evidence, issuedAt.')] }; }
  if (!SIG.test(signature)) return { ok: false, head: 'No signature to check', checks: [check(false, 'The signature must be 65 bytes of hex (0x and 130 characters).')] };
  if (d.name !== 'HEY Proof of Ship' || String(d.version) !== '1') checks.push(check(false, `The domain is <span class="mono">${esc(d.name)}</span> version ${esc(d.version)}, not HEY Proof of Ship version 1.`));
  const chainId = Number(d.chainId);
  const domain = { name: String(d.name), version: String(d.version), chainId };
  if (d.verifyingContract !== undefined) domain.verifyingContract = String(d.verifyingContract);
  if (d.salt !== undefined) domain.salt = String(d.salt);
  let digest, signer;
  try {
    digest = hashTypedData({ domain, types: SHIPS_TYPES, primaryType: 'Ships', message });
    signer = await recoverAddress({ hash: digest, signature });
  } catch { return { ok: false, head: 'The signature does not recover', checks: [...checks, check(false, 'No key recovers from this signature over this attestation and domain.')] }; }
  const isHey = sameHash(signer, CONFIG.attester);
  checks.push(check('info', `EIP-712 digest, rebuilt in your browser: <span class="mono">${digest}</span>`));
  if (typeof obj.digest === 'string') checks.push(check(sameHash(obj.digest, digest), sameHash(obj.digest, digest) ? 'The digest HEY printed beside it is the same.' : 'The digest HEY printed beside it is different: the page trusts only its own.'));
  checks.push(check(isHey, isHey
    ? `Signed by <b>HEY’s attester</b>, <span class="mono">${CONFIG.attester}</span>.`
    : `Signed by <span class="mono">${signer}</span>, <b>not HEY’s attester</b> (${short(CONFIG.attester)}). No Proof of Ship escrow pays on it.`));
  let where = null, binds = false;
  if (chainId === CONFIG.chainId) {
    const mine = domain.verifyingContract && sameHash(domain.verifyingContract, CONFIG.escrow);
    binds = Boolean(mine) && domain.salt === undefined;
    where = binds ? 'robinhood' : null;
    checks.push(check(binds, binds
      ? `Domain: chain <b>4663</b> with <span class="mono">verifyingContract</span> ShipEscrow, <span class="mono">${CONFIG.escrow}</span>. Only that escrow on Robinhood Chain pays it, in WIF.`
      : `Domain: chain 4663, but bound to <span class="mono">${esc(domain.verifyingContract ?? 'no contract')}</span>, not ShipEscrow. No Proof of Ship escrow pays it.`));
  } else if (chainId === NEAR.chainId || chainId === 398) {
    const mainnet = chainId === NEAR.chainId;
    const saltOk = domain.salt !== undefined && sameHash(domain.salt, NEAR_SALT) && domain.verifyingContract === undefined;
    binds = mainnet && saltOk;
    where = binds ? 'near' : null;
    checks.push(check(binds, binds
      ? `Domain: chain <b>397</b> (NEAR mainnet) with salt <span class="mono">keccak256("${NEAR.escrow}")</span>. Only <span class="mono">${NEAR.escrow}</span> pays it, in USDC.`
      : !mainnet ? 'Domain: chain 398, NEAR testnet. HEY never signs it for a payout, and this page never shows the testnet escrow.'
        : `Domain: chain 397, but its salt <span class="mono">${esc(domain.salt ?? 'missing')}</span> is not keccak256("${NEAR.escrow}"). No Proof of Ship escrow pays it.`));
  } else {
    checks.push(check(false, `Domain: chain ${esc(chainId)}. No Proof of Ship escrow is on it.`));
  }
  if (typeof obj.slug === 'string') {
    const ok = sameHash(keccak256(stringToBytes(obj.slug)), message.project);
    checks.push(check(ok, ok ? `Project: <b>${esc(obj.slug)}</b>, keccak256 of the slug’s bytes.` : `The project hash is not keccak256("${esc(obj.slug)}").`));
  }
  checks.push(check('info', `Says: <b>${message.ships} ship${message.ships === 1 ? '' : 's'}</b> counted between ${esc(stamp(message.since))} and ${esc(stamp(message.until))}, for payout to <span class="mono">${message.builder}</span>${where === 'near' ? ` (NEAR account <span class="mono">${message.builder.toLowerCase()}</span>)` : ''}; issued ${esc(stamp(message.issuedAt))}.`));
  // The escrow's own answer, read over public RPC: the contract that would pay says what it would accept.
  let crossOk = null;
  if (where === 'near') {
    try {
      const att = { project: a.project, builder: a.builder, since: String(message.since), until: String(message.until), ships: message.ships, evidence: a.evidence, issuedAt: String(message.issuedAt) };
      const r = await nearView('recover_signer', { attestation: att, signature });
      crossOk = Boolean(r?.is_attester) && sameHash(r?.signer, signer) && (r?.digest === undefined || sameHash(r.digest, digest));
      checks.push(check(crossOk, crossOk
        ? `<span class="mono">${NEAR.escrow}</span>’s own <span class="mono">recover_signer</span> recovers the same key and digest: <span class="mono">is_attester: true</span>.`
        : `<span class="mono">${NEAR.escrow}</span>’s <span class="mono">recover_signer</span> answers ${esc(r?.signer ?? r?.error ?? 'no signer')}, is_attester ${esc(r?.is_attester)}: the escrow would not accept it.`));
    } catch { checks.push(check('info', 'The NEAR escrow could not be asked just now.')); }
  } else if (where === 'robinhood') {
    try {
      const ABI = await abiPromise;
      const onChain = await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'digest', args: [message] });
      crossOk = sameHash(onChain, digest);
      checks.push(check(crossOk, crossOk ? 'ShipEscrow’s own <span class="mono">digest()</span> on Robinhood Chain returns the same digest.' : 'ShipEscrow’s <span class="mono">digest()</span> returns a different digest: the escrow would not accept it.'));
    } catch { checks.push(check('info', 'ShipEscrow could not be asked just now.')); }
  }
  checks.push(check('info', 'One attestation, one escrow: its domain names one escrow on one chain, and that escrow releases a bounty once.'));
  const ok = isHey && binds && crossOk !== false;
  const head = !isHey ? 'Not signed by HEY’s attester'
    : !binds ? 'Signed by HEY, for a domain no Proof of Ship escrow pays'
      : `Signed by HEY for ${where === 'near' ? `${NEAR.escrow} on NEAR (USDC)` : 'ShipEscrow on Robinhood Chain (WIF)'}`;
  return { ok, head, checks, where };
}
async function runVerify() {
  const out = $('#rcptOut');
  out.hidden = false;
  out.dataset.ok = '';
  out.innerHTML = '<div class="head"><i></i>Checking…</div>';
  $('#rcptIdle').hidden = true;
  const r = await verifyReceipt($('#rcpt').value.trim());
  out.dataset.ok = String(r.ok);
  out.dataset.where = r.where ?? '';
  out.innerHTML = `<div class="head"><i aria-hidden="true"></i><span id="rcptHead">${esc(r.head)}</span></div><ul class="checks">${r.checks.join('')}</ul>`;
}
async function example(on) {
  const hint = $('#rcptHint');
  const slug = on === 'near' ? 'loom' : 'predict-fwa';
  hint.className = 'hint';
  hint.textContent = `Asking HEY for a live attestation for ${slug}…`;
  try {
    const t = await fetch(`${CONFIG.hey}/api/v1/proof-of-ship/tie?slug=${slug}`).then((r) => r.json());
    const builder = (t?.ties ?? []).map((x) => x?.address).find((x) => isAddress(String(x)));
    if (!builder) throw new Error('HEY ties no payout address to it right now.');
    const until = now() - 120;
    const u = new URL(`${CONFIG.hey}/api/v1/proof-of-ship/attestation`);
    u.searchParams.set('slug', slug); u.searchParams.set('builder', builder);
    u.searchParams.set('since', String(until - 14 * 86400)); u.searchParams.set('until', String(until));
    u.searchParams.set('escrow', on === 'near' ? NEAR.heyEscrow : CONFIG.escrow);
    const r = await fetch(u);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(String(j?.message ?? `HEY answered ${r.status}.`));
    $('#rcpt').value = JSON.stringify(j, null, 2);
    hint.textContent = `HEY’s live attestation for ${slug}, last 14 days, for the ${on === 'near' ? 'NEAR' : 'Robinhood Chain'} escrow.`;
    await runVerify();
  } catch (e) { hint.className = 'hint bad'; hint.textContent = `The example could not be fetched: ${e.message}`; }
}
$('#rcptVerify').addEventListener('click', () => runVerify().catch(() => undefined));
$('#rcptExample').addEventListener('click', () => example('robinhood'));
$('#rcptExampleNear').addEventListener('click', () => example('near'));

// ------------------------------------------------------------------ project view (?project=<slug>)
const RECENT_DAYS = 30;
async function projectView(slug) {
  const el = $('#projectView');
  document.documentElement.dataset.view = 'project';
  setFilter({ project: slug });
  el.hidden = false;
  el.innerHTML = '<p class="muted">Reading the project on HEY…</p>';
  const link = `${PAGE_URL}?project=${slug}`;
  let p;
  try { p = await heyProject(slug); } catch { p = undefined; }
  const name = p?.name ?? slug;
  if (p) document.title = `${name} on Proof of Ship`;
  const badgeImg = `${PAGE_URL}badge.svg`;
  const snippet = `<a href="${link}"><img src="${badgeImg}" alt="Back ${esc(name)} on Proof of Ship" width="236" height="32"></a>`;
  const last = p?.lastShippedAt ? `last shipped ${day(Date.parse(p.lastShippedAt) / 1000)}` : p ? 'no ship read yet' : '';
  el.innerHTML = `
    <div class="pv-head">${logo(p?.logoUrl, name)}<div><p class="kicker">Project on Proof of Ship</p><h1 id="pvName">${esc(name)}</h1><div class="sl">${p === null ? 'HEY has no published project at this slug.' : `<a href="${CONFIG.hey}/project/${encodeURIComponent(slug)}" target="_blank" rel="noopener">heyresearch.xyz/project/${esc(slug)}</a>${last ? ` · ${esc(last)}` : ''}`}</div></div></div>
    <div class="pv-grid">
      <div class="box" id="pvShips"><h2>HEY’s counted ships, last ${RECENT_DAYS} days</h2><p class="muted">Reading HEY’s count…</p></div>
      <div class="pv-side">
      <div class="box"><h2>Back this builder</h2><p>Open a bounty for ${esc(name)} on either chain: the form fills in the project, and the payout address HEY ties to it.</p>
        <div class="back"><button class="go" type="button" data-back="robinhood">Back on Robinhood Chain · WIF</button><button class="go" type="button" data-back="near">Back on NEAR · USDC</button></div>
        <p>Every bounty for ${esc(name)} on both chains is listed below.</p>
        <a class="close" href="./">Show every project</a>
      </div>
      <div class="box"><h2>Share this page</h2><div class="row"><input class="copy" id="pvLink" readonly value="${esc(link)}" aria-label="Link to this project’s page"><button type="button" class="link-btn" data-copy="#pvLink">Copy</button></div></div>
      <div class="box"><h2>Put a badge on your site</h2><p>A plain link with an image from this page, no frame and no script.</p><div class="row"><textarea id="pvEmbed" rows="3" readonly aria-label="Badge snippet">${esc(snippet)}</textarea><button type="button" class="link-btn" data-copy="#pvEmbed">Copy</button></div><a href="${esc(link)}"><img src="./badge.svg" alt="Back ${esc(name)} on Proof of Ship" width="236" height="32"></a></div>
      </div>
    </div>`;
  wireLogos(el);
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const f = $(b.dataset.copy);
    try { await navigator.clipboard.writeText(f.value); toast('Copied.'); } catch { f.focus(); f.select(); toast('Select and copy it.'); }
  }));
  el.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => backThis(b.dataset.back, slug)));
  // HEY's count of the last 30 closed days, by the payout rule: what a bounty opened now would have counted.
  const until = Math.floor((now() - 300) / 3600) * 3600;
  const box = $('#pvShips');
  try {
    const j = await heyShips(slug, until - RECENT_DAYS * 86400, until);
    if (j.ships === null || j.ships === undefined) {
      box.innerHTML = `<h2>HEY’s counted ships, last ${RECENT_DAYS} days</h2><p data-ships="null">HEY can’t measure ${esc(name)}’s shipping right now. ${esc(String(j.reasonText || 'HEY gave no reason.'))}</p>`;
      return;
    }
    const ids = Array.isArray(j.evidenceIds) ? j.evidenceIds : [];
    const urls = Array.isArray(j.evidenceUrls) ? j.evidenceUrls : [];
    const titles = new Map((await shipTitles(slug, ids).catch(() => [])).map((s) => [s.id, s]));
    const items = ids.slice(0, 8).map((id, i) => {
      const s = titles.get(id);
      const ev = httpsUrl(urls[i]), src = httpsUrl(s?.source);
      const what = s ? `<b>${esc(KIND[s.kind] ?? s.kind ?? 'Ship')}</b> · ${esc(s.title ?? '')}` : `<b>Counted ship</b> · <span class="mono">${esc(String(id).slice(0, 13))}…</span>`;
      return `<li><span>${what}${ev ? ` <a href="${esc(ev)}" target="_blank" rel="noopener">evidence ↗</a>` : ''}${src ? ` <a href="${esc(src)}" target="_blank" rel="noopener">source ↗</a>` : ''}</span></li>`;
    });
    box.innerHTML = `<h2>HEY’s counted ships, last ${RECENT_DAYS} days</h2><p data-ships="${j.ships}"><b>${j.ships}</b> ship${j.ships === 1 ? '' : 's'} by HEY’s payout rule, ${esc(day(until - RECENT_DAYS * 86400))} to ${esc(day(until))}: at most one of each kind a day, a code week once it has ended.</p>${items.length ? `<ul class="ships">${items.join('')}${ids.length > 8 ? `<li><span>and ${ids.length - 8} more</span></li>` : ''}</ul>` : ''}`;
  } catch (e) { box.innerHTML = `<h2>HEY’s counted ships, last ${RECENT_DAYS} days</h2><p>HEY’s count could not be read just now${e?.message ? `: ${esc(e.message)}` : ''}.</p>`; }
}
/** "Back this builder": the chosen chain's form, with the project written in as if picked (the form checks the rest). */
function backThis(on, slug) {
  document.querySelector(`#chainSwitch [data-pick="${on}"]`)?.click();
  const input = $(on === 'near' ? '#nSlug' : '#slug');
  input.value = slug;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  $('#open-section').scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

// ------------------------------------------------------------------ start
const projectSlug = new URLSearchParams(location.search).get('project');
setFilter({ chain: urlShow ?? 'all', project: projectSlug && SLUG_RE.test(projectSlug) ? projectSlug : null });
if (projectSlug && SLUG_RE.test(projectSlug)) projectView(projectSlug).catch(() => undefined);
renderFigures();
readDiagram().catch(() => undefined);
loadFeed().catch(() => { $('#feedNote').textContent = 'The activity could not be read just now.'; });
