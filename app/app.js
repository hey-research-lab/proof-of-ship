import {
  createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, getAddress, isAddress,
} from 'https://esm.sh/viem@2.21.55';
import { CONFIG } from './config.js';

const chain = {
  id: CONFIG.chainId, name: CONFIG.chainName,
  nativeCurrency: { name: 'Ether', symbol: CONFIG.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CONFIG.explorer } },
};
const pub = createPublicClient({ chain, transport: http(CONFIG.rpc) });
const ABI = await (await fetch('./ShipEscrow.abi.json')).json();
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
async function connect() {
  if (!window.ethereum) { toast('No browser wallet found. Install one (Rabby, MetaMask) to back or release a bounty.'); return; }
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); } catch { await wallet.addChain({ chain }); await wallet.switchChain({ id: chain.id }); }
  $('#who').innerHTML = `<span class="dot"></span>${short(account)}`;
  $('#connect').textContent = 'Connected';
  $('#connect').disabled = true;
  showBalance();
  await load();
}
async function needWallet() { if (!account) await connect(); if (!account) throw new Error('Connect a wallet first.'); }
async function send(req, label) {
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
async function showBalance() {
  if (!account) return;
  const bal = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'balanceOf', args: [account] }).catch(() => null);
  if (bal !== null) $('#balHint').textContent = `You hold ${fmt(bal)} ${T.symbol}.`;
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
/** Fallback while the attestation endpoint isn't answering: counted ships on the project's timeline in the window. */
async function timelineShips(slug, since, until) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 4; page++) {
    const u = new URL(`${CONFIG.hey}/api/projects/${encodeURIComponent(slug)}/timeline`);
    u.searchParams.set('limit', '500');
    if (cursor) u.searchParams.set('before', cursor);
    const r = await fetch(u);
    if (!r.ok) break;
    const j = await r.json();
    let older = false;
    for (const it of j.items ?? []) {
      const t = Math.floor(Date.parse(it.at) / 1000);
      if (t < since) { older = true; continue; }
      if (t <= until && it.countsAsBuilding) out.push(it);
    }
    if (older || !j.nextCursor) break;
    cursor = j.nextCursor;
  }
  return out;
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
    const how = res.body.builderTie === 'wallet_claim' ? 'it signed to claim the project on HEY' : 'it deployed the project’s verified token';
    hint.className = 'hint ok'; hint.textContent = `HEY ties this address to the project: ${how}.`;
  } else if (res.status === 403) {
    hint.className = 'hint bad'; hint.textContent = 'HEY doesn’t tie this address to the project, so it would never sign a payout to it.';
  }
}, 450);
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
    if (!v.slug) throw new Error('Enter the project’s slug on HEY.');
    if (!isAddress(v.builder)) throw new Error('The payout address is not a valid address.');
    if (v.minShips < 1) throw new Error('A bounty needs at least one ship.');
    if (v.days < 1 || v.days > 365) throw new Error('Time to ship is 1 to 365 days.');
    const project = await heyProject(v.slug);
    if (!project) throw new Error(`HEY has no published project "${v.slug}".`);
    await needWallet();
    btn.disabled = true;
    const deadline = BigInt(now() + v.days * 86400);
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
  } else if (!b.paid) {
    ships = await timelineShips(slug, Number(b.start), until).catch(() => []);
    have = ships.length;
  }
  const need = Number(b.minShips);
  const graceEnd = Number(b.deadline) + GRACE;
  const inWindow = !b.paid && now() <= graceEnd;
  const met = have !== null && have >= need;
  const state = b.paid ? ['ok', 'Paid out']
    : note ? ['off', 'Payout address not tied']
    : met && inWindow ? ['ok', 'Target met · ready to release']
    : now() > graceEnd ? ['off', 'Closed · backers can take back']
    : now() > Number(b.deadline) ? ['wait', 'Deadline passed · grace period']
    : ['wait', 'Building'];
  const pct = b.paid ? 100 : have === null ? 0 : Math.min(100, Math.round((have / need) * 100));
  const name = project?.name ?? slug;
  const actions = [];
  if (met && inWindow && !note) actions.push(`<button class="go" data-act="claim" data-id="${id}">Release to builder</button>`);
  if (!b.paid && now() < Number(b.deadline)) actions.push(`<button data-act="fund" data-id="${id}">Add ${T.symbol}</button>`);
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
    const v = prompt(`How much ${T.symbol} to add to bounty #${id}?`, '10000');
    if (!v) return;
    const amount = parseUnits(v, T.decimals);
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
renderPreview();
renderContract();
load().catch(fail);
