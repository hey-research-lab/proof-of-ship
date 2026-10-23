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

// ------------------------------------------------------------------ ui helpers
const status = (msg) => { $('#status').innerHTML = msg ? `<div>${msg}</div>` : ''; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v) => Number(formatUnits(v, T.decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const day = (s) => new Date(Number(s) * 1000).toUTCString().slice(5, 16);
const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ wallet
async function connect() {
  if (!window.ethereum) { status('No wallet found. Install a browser wallet to back or claim a bounty.'); return; }
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: chain.id });
  } catch {
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }
  $('#who').textContent = short(account);
  $('#connect').textContent = 'Connected';
  $('#connect').disabled = true;
  await load();
}
async function needWallet() { if (!account) await connect(); if (!account) throw new Error('Connect a wallet first.'); }
async function send(req, label) {
  status(`${label}: confirm in your wallet…`);
  const hash = await wallet.writeContract({ account, chain, ...req });
  status(`${label}: waiting for <a href="${CONFIG.explorer}/tx/${hash}" target="_blank" rel="noopener">the transaction</a>…`);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${label} reverted.`);
  return hash;
}
async function ensureAllowance(amount) {
  const have = await pub.readContract({ address: T.address, abi: ERC20, functionName: 'allowance', args: [account, CONFIG.escrow] });
  if (have >= amount) return;
  await send({ address: T.address, abi: ERC20, functionName: 'approve', args: [CONFIG.escrow, amount] }, `Approve ${fmt(amount)} ${T.symbol}`);
}

// ------------------------------------------------------------------ HEY reads (public API, no key)
async function heyProject(slug) {
  const r = await fetch(`${CONFIG.hey}/api/projects/${encodeURIComponent(slug)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HEY answered ${r.status}`);
  const j = await r.json();
  return j.project ?? j;
}
/** The ships HEY counts as building for `slug` between `since` and `until` (unix seconds). */
async function countedShips(slug, since, until) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 6; page++) {
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

// ------------------------------------------------------------------ bounties
async function load() {
  const box = $('#bounties');
  if (!CONFIG.escrow) {
    box.innerHTML = '<p class="empty">The escrow is being deployed on Robinhood Chain. Bounties appear here as soon as it is live.</p>';
    return;
  }
  const count = Number(await pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bountyCount' }));
  if (count === 0) { box.innerHTML = '<p class="empty">No bounties yet. Open the first one above.</p>'; return; }
  const ids = [...Array(count).keys()].reverse();
  const cards = await Promise.all(ids.map(renderBounty));
  box.innerHTML = cards.join('');
  box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, Number(b.dataset.id)).catch(fail)));
}

async function renderBounty(id) {
  const [b, slug] = await Promise.all([
    pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'bounty', args: [BigInt(id)] }),
    pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'slugOf', args: [BigInt(id)] }),
  ]);
  const until = Math.min(now(), Number(b.deadline));
  const [project, ships, mine] = await Promise.all([
    heyProject(slug).catch(() => null),
    countedShips(slug, Number(b.start), until).catch(() => []),
    account ? pub.readContract({ address: CONFIG.escrow, abi: ABI, functionName: 'contributed', args: [BigInt(id), account] }) : 0n,
  ]);
  const need = Number(b.minShips), have = ships.length;
  const graceEnd = Number(b.deadline) + GRACE;
  const open = !b.paid && now() <= graceEnd;
  const met = have >= need;
  const state = b.paid ? ['ok', 'Paid out'] : met && open ? ['ok', 'Target met · ready to release'] : now() > graceEnd ? ['off', 'Closed · backers can take back'] : now() > Number(b.deadline) ? ['wait', 'Deadline passed · grace period'] : ['wait', 'Building'];
  const pct = Math.min(100, Math.round((have / need) * 100));
  const name = project?.name ?? slug;
  const actions = [];
  if (!b.paid && now() < Number(b.deadline)) actions.push(`<button data-act="fund" data-id="${id}">Add $WIF</button>`);
  if (met && open) actions.push(`<button class="primary" data-act="claim" data-id="${id}">Release to builder</button>`);
  if (!b.paid && now() > graceEnd && mine > 0n) actions.push(`<button data-act="refund" data-id="${id}">Take back ${fmt(mine)} ${T.symbol}</button>`);
  const list = ships.slice(0, 5).map((s) => `<li>${esc(s.title ?? s.kind)}${s.source ? ` · <a href="${esc(s.source)}" target="_blank" rel="noopener">source</a>` : ''}</li>`).join('');
  return `<article class="card">
    <div class="top"><div><span class="name">${esc(name)}</span> <a class="mono" href="${CONFIG.hey}/project/${encodeURIComponent(slug)}" target="_blank" rel="noopener">heyresearch.xyz/project/${esc(slug)}</a></div><span class="chip ${state[0]}">${state[1]}</span></div>
    <div class="facts">
      <div class="fact"><div class="k">Bounty</div><div class="v">${fmt(b.total)} ${T.symbol}</div></div>
      <div class="fact"><div class="k">Ships HEY counted</div><div class="v">${have} of ${need}</div></div>
      <div class="fact"><div class="k">Ship by</div><div class="v">${day(b.deadline)}</div></div>
      <div class="fact"><div class="k">Burn on payout</div><div class="v">${(Number(b.burnBps) / 100).toFixed(1)}%</div></div>
      <div class="fact"><div class="k">Pays</div><div class="v"><a href="${CONFIG.explorer}/address/${b.builder}" target="_blank" rel="noopener">${short(b.builder)}</a></div></div>
    </div>
    <div class="bar" aria-label="${have} of ${need} ships"><i style="width:${pct}%"></i></div>
    ${list ? `<ul class="ships">${list}</ul>` : '<p class="hint">No counted ships since the bounty opened yet.</p>'}
    ${actions.length ? `<div class="row">${actions.join('')}</div>` : ''}
    <div class="mono">Bounty #${id} · opened ${day(b.start)}${mine > 0n ? ` · you put in ${fmt(mine)} ${T.symbol}` : ''}</div>
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
    status('Asking HEY to sign the ship count…');
    const u = new URL(`${CONFIG.hey}/api/v1/proof-of-ship/attestation`);
    u.searchParams.set('slug', slug);
    u.searchParams.set('since', String(b.start));
    u.searchParams.set('until', String(Math.min(now(), Number(b.deadline))));
    u.searchParams.set('escrow', CONFIG.escrow);
    // HEY signs only for a payout address the project verified to HEY; the escrow checks it equals the bounty's builder.
    u.searchParams.set('builder', b.builder);
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok) throw new Error(j.message ?? `HEY answered ${r.status}`);
    const a = j.attestation;
    const att = { project: a.project, builder: getAddress(a.builder), since: BigInt(a.since), until: BigInt(a.until), ships: Number(a.ships), evidence: a.evidence, issuedAt: BigInt(a.issuedAt) };
    if (att.builder !== getAddress(b.builder)) throw new Error('HEY does not attest this payout address for the project.');
    if (att.ships < Number(b.minShips)) throw new Error(`HEY counts ${att.ships} ships; the bounty needs ${b.minShips}.`);
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'claim', args: [BigInt(id), att, j.signature] }, 'Release');
  } else if (kind === 'refund') {
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'refund', args: [BigInt(id)] }, 'Take back');
  }
  status('Done.');
  setTimeout(() => status(''), 4000);
  await load();
}

// ------------------------------------------------------------------ create
$('#create').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!CONFIG.escrow) throw new Error('The escrow is not deployed yet.');
    await needWallet();
    const f = new FormData(e.target);
    const slug = String(f.get('slug')).trim().toLowerCase();
    const builder = String(f.get('builder')).trim();
    if (!isAddress(builder)) throw new Error('The payout address is not a valid address.');
    const project = await heyProject(slug);
    if (!project) throw new Error(`HEY has no published project "${slug}". Check heyresearch.xyz/project/${slug}.`);
    const minShips = Number(f.get('minShips'));
    const deadline = BigInt(now() + Number(f.get('days')) * 86400);
    const burnBps = Math.round(Number(f.get('burn')) * 100);
    const amount = parseUnits(String(f.get('amount') || '0'), T.decimals);
    if (amount > 0n) await ensureAllowance(amount);
    await send({ address: CONFIG.escrow, abi: ABI, functionName: 'create', args: [T.address, getAddress(builder), slug, minShips, deadline, burnBps, amount] }, 'Open bounty');
    status('Bounty opened.');
    e.target.reset();
    await load();
  } catch (err) { fail(err); }
});
$('#create [name=slug]').addEventListener('change', async (e) => {
  const slug = e.target.value.trim().toLowerCase();
  const p = slug ? await heyProject(slug).catch(() => null) : null;
  $('#slugHint').textContent = !slug ? 'heyresearch.xyz/project/<slug>' : p ? `${p.name} · ${p.activityStatus ?? ''}`.trim() : 'Not a published project on HEY';
});

function fail(err) { status(esc(err?.shortMessage ?? err?.message ?? String(err))); }
$('#connect').addEventListener('click', () => connect().catch(fail));
load().catch(fail);
