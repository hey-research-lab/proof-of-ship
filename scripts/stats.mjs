// Redraws the README's pictures and its bounties table from Robinhood Chain itself.
//   node --no-warnings scripts/stats.mjs
// The hero and the flow are drawn from no data. The stats card and the table are read from the escrow's own events
// (eth_getLogs from its deploy block, in bounded block ranges) and two calls, all over the public RPC: no key, no
// dependency beyond the viem bundle the page already ships (app/vendor/viem.js, for keccak256). A failed or
// inconsistent read writes nothing: the last good card and table stay, never zeros.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../app/config.js';
import { keccak256, stringToBytes } from '../app/vendor/viem.js';
import { flow, hero, statsCard } from './visuals.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (file, body) => writeFileSync(join(root, file), body);
const APP = 'https://hey-research-lab.github.io/proof-of-ship/';
const GRACE = 3 * 86_400; // ShipEscrow.CLAIM_GRACE
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/; // a HEY slug, as the page checks it
const T = CONFIG.token;

// ---------------------------------------------------------------- the pictures that need no data
for (const theme of ['light', 'dark']) {
  out(`docs/hero-${theme}.svg`, hero(theme));
  out(`docs/flow-${theme}.svg`, flow(theme));
}

// ---------------------------------------------------------------- the chain
const topic = (signature) => keccak256(stringToBytes(signature));
const TOPIC = {
  created: topic('BountyCreated(uint256,address,address,bytes32,string,uint32,uint64,uint64,uint16)'),
  funded: topic('Funded(uint256,address,uint256,uint256)'),
  claimed: topic('Claimed(uint256,address,uint256,uint256,uint32,bytes32)'),
  refunded: topic('Refunded(uint256,address,uint256)'),
  retired: topic('EscrowRetired()'),
};
const HEX = /^0x[0-9a-fA-F]*$/;

let id = 0;
async function rpc(method, params) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(CONFIG.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'proof-of-ship-readme' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
      return body.result;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`${method} failed: ${last?.message ?? last}`);
}
const hexBlock = (n) => `0x${n.toString(16)}`;

/** Every log the escrow emitted from its deploy block to `head`, in bounded ranges; a range the node refuses is halved. */
async function escrowLogs(from, head) {
  const logs = [];
  let span = 2_000_000, requests = 0;
  for (let start = from; start <= head; ) {
    if (++requests > 400) throw new Error('eth_getLogs: more than 400 requests, stopping');
    const end = Math.min(start + span - 1, head);
    let page;
    try {
      page = await rpc('eth_getLogs', [{ address: CONFIG.escrow, fromBlock: hexBlock(start), toBlock: hexBlock(end) }]);
    } catch (err) {
      if (span <= 10_000) throw err;
      span = Math.floor(span / 2);
      continue;
    }
    if (!Array.isArray(page)) throw new Error('eth_getLogs answered no list');
    for (const log of page) {
      const ok = log && log.address?.toLowerCase() === CONFIG.escrow.toLowerCase() && Array.isArray(log.topics)
        && log.topics.every((x) => HEX.test(x)) && HEX.test(log.data) && HEX.test(log.transactionHash) && HEX.test(log.blockNumber);
      if (!ok) throw new Error('eth_getLogs answered a malformed log');
      if (log.removed) continue;
      logs.push(log);
    }
    start = end + 1;
  }
  return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
}

const word = (data, i) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);
function readString(data, offsetWord) {
  const at = 2 + Number(word(data, offsetWord)) * 2;
  const len = Number(BigInt(`0x${data.slice(at, at + 64)}`));
  const hex = data.slice(at + 64, at + 64 + len * 2);
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16)));
}
const selector = (signature) => topic(signature).slice(0, 10);
const pad = (address) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const head = Number(BigInt(await rpc('eth_blockNumber', [])));
const from = Number(CONFIG.escrowFromBlock);
if (!Number.isFinite(head) || head < from) throw new Error(`head ${head} is before the deploy block ${from}`);
const logs = await escrowLogs(from, head);
const at = hexBlock(head);
const count = Number(BigInt(await rpc('eth_call', [{ to: CONFIG.escrow, data: selector('bountyCount()') }, at])));
const locked = BigInt(await rpc('eth_call', [{ to: T.address, data: `${selector('balanceOf(address)')}${pad(CONFIG.escrow)}` }, at]));
const headTime = Number(BigInt((await rpc('eth_getBlockByNumber', [at, false])).timestamp));

const bounties = new Map();
let retired = false;
for (const log of logs) {
  const [sig, a, b] = log.topics;
  const bid = a === undefined ? null : Number(BigInt(a));
  if (sig === TOPIC.created) {
    bounties.set(bid, {
      id: bid,
      builder: `0x${b.slice(26)}`,
      project: `0x${log.data.slice(2, 66)}`,
      slug: readString(log.data, 1),
      minShips: Number(word(log.data, 2)),
      start: Number(word(log.data, 3)),
      deadline: Number(word(log.data, 4)),
      burnBps: Number(word(log.data, 5)),
      openedTx: log.transactionHash,
      funded: 0n, refunded: 0n, paid: null,
    });
  } else if (sig === TOPIC.funded) {
    bounties.get(bid).funded += word(log.data, 0);
  } else if (sig === TOPIC.claimed) {
    bounties.get(bid).paid = { paid: word(log.data, 0), burned: word(log.data, 1), ships: Number(word(log.data, 2)), tx: log.transactionHash };
  } else if (sig === TOPIC.refunded) {
    bounties.get(bid).refunded += word(log.data, 0);
  } else if (sig === TOPIC.retired) {
    retired = true;
  }
}

// The events must agree with the contract's own state, or nothing is written.
const list = [...bounties.values()].sort((x, y) => y.id - x.id);
if (list.length !== count) throw new Error(`events show ${list.length} bounties, bountyCount() says ${count}`);
if (list.some((x, i) => x.id !== count - 1 - i)) throw new Error('bounty ids are not 0 to count - 1');
const held = list.reduce((sum, x) => sum + (x.paid ? 0n : x.funded - x.refunded), 0n);
if (locked < held) throw new Error(`the escrow holds ${locked}, less than the ${held} its events leave in bounties`);

// ---------------------------------------------------------------- figures
function units(v, max = 2) {
  const scale = 10n ** BigInt(T.decimals);
  const whole = v / scale, frac = v % scale;
  const cents = frac.toString().padStart(T.decimals, '0').slice(0, max).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${cents ? `.${cents}` : ''}`;
}
function compact(v) {
  const whole = Number(v / 10n ** BigInt(T.decimals));
  if (whole >= 1e9) return `${(whole / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (whole >= 1e6) return `${(whole / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  return units(v, whole >= 1000 ? 0 : 2);
}
const paidOut = list.filter((x) => x.paid);
const toBuilders = paidOut.reduce((s, x) => s + x.paid.paid, 0n);
const burned = paidOut.reduce((s, x) => s + x.paid.burned, 0n);
const tiles = [
  { value: compact(locked), unit: T.symbol, label: 'locked in the escrow now' },
  { value: compact(toBuilders), unit: T.symbol, label: 'paid to builders who shipped', accent: true },
  { value: compact(burned), unit: T.symbol, label: 'burned at release, as backers chose' },
  { value: count.toLocaleString('en-US'), label: count === 1 ? 'bounty opened' : 'bounties opened' },
  { value: paidOut.length.toLocaleString('en-US'), label: paidOut.length === 1 ? 'bounty paid out' : 'bounties paid out', accent: true },
];

// ---------------------------------------------------------------- the table
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const when = (s, time = true) => {
  const d = new Date(s * 1000);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return time ? `${date}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` : date;
};
const txLink = (hash) => `[\`${hash.slice(0, 6)}…${hash.slice(-4)}\`](${CONFIG.explorer}/tx/${hash})`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function status(x) {
  if (x.paid) {
    const burnt = x.paid.burned > 0n ? `, ${units(x.paid.burned)} burned` : '';
    return `**Paid** at ${plural(x.paid.ships, 'ship', 'ships')}: ${units(x.paid.paid)} ${T.symbol} to the builder${burnt} · ${txLink(x.paid.tx)}`;
  }
  if (x.funded === 0n) return 'Nothing locked';
  const left = x.funded - x.refunded;
  if (left === 0n) return 'Refunded';
  if (retired) return 'Refunds open (escrow retired)';
  if (headTime <= x.deadline) return '**Open**';
  if (headTime <= x.deadline + GRACE) return `Deadline passed · can be released until ${when(x.deadline + GRACE)}`;
  return x.refunded > 0n ? `Refunds open · ${units(x.refunded)} ${T.symbol} returned so far` : 'Refunds open';
}

function row(x) {
  const hashOk = SLUG_RE.test(x.slug) && keccak256(stringToBytes(x.slug)).toLowerCase() === x.project.toLowerCase();
  const project = hashOk ? `[${x.slug}](${CONFIG.hey}/project/${x.slug})` : 'not a HEY slug: can never be released';
  return `| [#${x.id}](${APP}#bounty-${x.id}) | ${project} | ${units(x.funded)} ${T.symbol} | ${plural(x.minShips, 'ship', 'ships')} | ${when(x.deadline)} | ${status(x)} | ${txLink(x.openedTx)} |`;
}
const HEAD = ['| Bounty | Project | Amount | Target | Deadline | Status | Opened |', '| :-- | :-- | --: | :-- | :-- | :-- | :-- |'];
const SHOWN = 10;
const table = [
  `${plural(count, 'bounty', 'bounties')} on chain, newest first. Read from the escrow's events every day; each bounty number opens its card in the app.`,
  '',
  ...HEAD,
  ...list.slice(0, SHOWN).map(row),
  ...(list.length > SHOWN
    ? ['', '<details>', `<summary><b>${plural(list.length - SHOWN, 'older bounty', 'older bounties')}</b></summary>`, '', ...HEAD, ...list.slice(SHOWN).map(row), '', '</details>']
    : []),
].join('\n');

// ---------------------------------------------------------------- write, only now that every read agreed
for (const theme of ['light', 'dark']) out(`docs/stats-${theme}.svg`, statsCard(tiles, theme));
const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const markers = /(<!-- bounties:start -->)[\s\S]*?(<!-- bounties:end -->)/;
if (!markers.test(readme)) throw new Error('README.md has no bounties markers');
writeFileSync(readmePath, readme.replace(markers, `$1\n${table}\n$2`));
console.log(`block ${head}: ${count} bounties, ${paidOut.length} paid, locked ${units(locked)}, paid ${units(toBuilders)}, burned ${units(burned)}, ${logs.length} logs`);
