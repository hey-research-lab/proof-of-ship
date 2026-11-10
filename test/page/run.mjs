#!/usr/bin/env node
// Playwright checks of the Proof of Ship page (app/), on both chains, with nothing live:
//   - NEAR: a mocked NEAR RPC that runs the escrow's rules (create, ft_transfer_call, claim, refund, the views), a
//     mocked HEY (search, tie, attestation signed with the PUBLIC test key under the NEAR domain) and a test wallet.
//     First with HEY not signing for NEAR (the route before its NEAR deploy answers 400), then signing.
//   - Robinhood Chain: a mocked RPC answering ShipEscrow's reads and an injected EIP-1193 wallet, to show the flow is
//     unchanged up to the first wallet prompt (approve $WIF to the escrow), which the test wallet refuses.
// The page's two config files are served with the public test attester in place of HEY's, so the mocked HEY's
// signatures verify; nothing else of the page is changed. Screenshots go to test/page/shots/.
//
//   cd test/page && npm ci && npx playwright-core install chromium && node run.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { decodeFunctionData, domainSeparator, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '../../app');
const SHOTS = path.join(here, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const TEST_KEY = keccak256(stringToBytes('hey-proof-of-ship-near test attester'));
const attester = privateKeyToAccount(TEST_KEY);
const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400, GRACE = 3 * DAY;

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// ------------------------------------------------------------------ static server for app/
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = path.join(APP, decodeURIComponent(u.pathname));
  if (!file.startsWith(APP)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ mocked HEY
const PROJECTS = {
  'predict-fwa': { slug: 'predict-fwa', name: 'predict FWA', activityStatus: 'SHIPPING', lastShippedAt: new Date(Date.now() - DAY * 1000).toISOString(), logoUrl: null },
  'fly-ai': { slug: 'fly-ai', name: 'fly.ai', activityStatus: 'SHIPPING', lastShippedAt: new Date(Date.now() - 2 * DAY * 1000).toISOString(), logoUrl: null },
  'quiet-labs': { slug: 'quiet-labs', name: 'Quiet Labs', activityStatus: 'UNKNOWN', lastShippedAt: null, logoUrl: null },
  'long-name': { slug: 'long-name', name: `The ${'Extraordinarily Long Named '.repeat(5)}Protocol`, activityStatus: 'SHIPPING', lastShippedAt: null, logoUrl: null },
  loom: { slug: 'loom', name: 'Loom', activityStatus: 'SHIPPING', lastShippedAt: new Date(Date.now() - DAY * 1000).toISOString(), logoUrl: null },
};
const TIES = { 'predict-fwa': '0x420944b441715E34Dd672AE0Eb4526A7AD7d1EEF', 'fly-ai': '0x625862521777E19Ad54Ce6C7ABeD9Ca54D6589ea', 'quiet-labs': '0x1234567890123456789012345678901234567890', 'long-name': '0x2222222222222222222222222222222222222222', loom: '0x2f7CE7eeF4b091E0827dA1E8C2E10D061d95d180' };
const SHIPS = { 'predict-fwa': 3, 'fly-ai': 1, 'quiet-labs': 0, 'long-name': 0, loom: 2 };
// HEY's unsigned count of the last 14 days (the pace hint): null is "HEY can't measure it", never 0.
const SHIPS_14D = { 'predict-fwa': 10, 'fly-ai': 1, 'quiet-labs': null, 'long-name': 2, loom: 7 };
const NEAR_ESCROW = 'escrow.heyresearch.near';
const RH_ESCROW = '0x3Da17a89F1d29aB96419269514C798a8dd6125f2';
const hey = { nearLive: false, attestations: [], shipsCalls: [] };
const SHIPS_TYPES = { Ships: [{ name: 'project', type: 'bytes32' }, { name: 'builder', type: 'address' }, { name: 'since', type: 'uint64' }, { name: 'until', type: 'uint64' }, { name: 'ships', type: 'uint32' }, { name: 'evidence', type: 'bytes32' }, { name: 'issuedAt', type: 'uint64' }] };
const nearDomain = { name: 'HEY Proof of Ship', version: '1', chainId: 397, salt: keccak256(stringToBytes(NEAR_ESCROW)) };
const rhDomain = { name: 'HEY Proof of Ship', version: '1', chainId: 4663, verifyingContract: RH_ESCROW };
const shipIds = (slug, n) => Array.from({ length: n }, (_, i) => `ship:00000000-0000-4000-8000-${String(i + 1).padStart(6, '0')}${slug.length.toString().padStart(6, '0')}`);
async function heyRoute(route) {
  const u = new URL(route.request().url());
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  if (u.pathname === '/api/search/suggest') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    return json(200, { suggestions: Object.values(PROJECTS).filter((p) => p.slug.includes(q) || p.name.toLowerCase().includes(q)).map((p) => ({ type: 'project', target: `/project/${p.slug}`, name: p.name, status: 'Shipping · Verified Builder' })) });
  }
  let m = /^\/api\/projects\/([^/]+)\/timeline$/.exec(u.pathname);
  if (m) return json(200, { items: shipIds(m[1], SHIPS[m[1]] ?? 0).map((id, i) => ({ id, kind: i === 0 ? 'release' : 'code', title: i === 0 ? 'v1.4.0' : `Code week ${i}`, recordedAt: new Date().toISOString(), source: `https://github.com/example/${m[1]}` })) });
  m = /^\/api\/projects\/([^/]+)$/.exec(u.pathname);
  if (m) return PROJECTS[m[1]] ? json(200, { project: PROJECTS[m[1]] }) : json(404, { error: 'not_found' });
  if (u.pathname === '/api/v1/proof-of-ship/tie') {
    const slug = u.searchParams.get('slug');
    return PROJECTS[slug] ? json(200, { slug, currentSlug: slug, payable: true, ties: [{ kind: 'wallet_claim', address: TIES[slug] }] }) : json(404, { error: 'not_found' });
  }
  if (u.pathname === '/api/v1/proof-of-ship/ships') {
    const p = Object.fromEntries(u.searchParams);
    hey.shipsCalls.push(p);
    if (!PROJECTS[p.slug]) return json(404, { error: 'not_found' });
    if (!(Number(p.until) <= NOW() && Number(p.since) < Number(p.until))) return json(400, { error: 'invalid_parameter', message: 'The window has not ended.' });
    const n = SHIPS_14D[p.slug];
    if (n === null) return json(200, { slug: p.slug, currentSlug: p.slug, since: Number(p.since), until: Number(p.until), ships: null, evidenceIds: null, evidenceUrls: null, evidenceHash: null, reason: 'activity_not_measured', reasonText: 'HEY does not measure this project’s building right now: no builder source it reads.' });
    const ids = shipIds(p.slug, n);
    return json(200, { slug: p.slug, currentSlug: p.slug, since: Number(p.since), until: Number(p.until), ships: n, evidenceIds: ids, evidenceUrls: ids.map((id) => `https://heyresearch.xyz/evidence/${id}`), evidenceHash: '0x' });
  }
  if (u.pathname === '/api/v1/proof-of-ship/attestation') {
    const p = Object.fromEntries(u.searchParams);
    hey.attestations.push(p);
    const isNear = p.escrow?.startsWith('near:');
    if (isNear && (!hey.nearLive || p.escrow !== `near:${NEAR_ESCROW}`)) return json(400, { error: 'invalid_parameter', message: 'Give the escrow contract: ?escrow=0x followed by 40 hex characters.', retryable: false });
    if (!isNear && p.escrow?.toLowerCase() !== RH_ESCROW.toLowerCase()) return json(400, { error: 'invalid_parameter', message: 'HEY does not sign for this escrow.' });
    if (!PROJECTS[p.slug]) return json(404, { error: 'not_found', message: 'No published project at this slug.' });
    if (p.builder?.toLowerCase() !== TIES[p.slug].toLowerCase()) return json(403, { error: 'builder_not_tied', message: 'HEY does not tie this address to the project.' });
    const issuedAt = NOW() - 60;
    const until = Math.min(Number(p.until ?? issuedAt), issuedAt);
    const ids = shipIds(p.slug, SHIPS[p.slug]).sort();
    const attestation = { project: keccak256(stringToBytes(p.slug)), builder: getAddress(p.builder), since: Number(p.since), until, ships: ids.length, evidence: keccak256(stringToBytes(ids.join(','))), issuedAt };
    const domain = isNear ? nearDomain : rhDomain;
    const message = { ...attestation, since: BigInt(attestation.since), until: BigInt(attestation.until), issuedAt: BigInt(issuedAt) };
    const signature = await attester.signTypedData({ domain, types: SHIPS_TYPES, primaryType: 'Ships', message });
    const digest = hashTypedData({ domain, types: SHIPS_TYPES, primaryType: 'Ships', message });
    const typedData = { types: { EIP712Domain: Object.keys(domain).map((k) => ({ name: k, type: { name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address', salt: 'bytes32' }[k] })), ...SHIPS_TYPES }, primaryType: 'Ships', domain, message: attestation };
    return json(200, { attestation, signature, signer: attester.address, domain, escrow: p.escrow, escrowKind: isNear ? 'near' : 'evm', digest, typedData, slug: p.slug, currentSlug: p.slug, builderTie: 'wallet_claim', evidenceIds: ids, evidenceUrls: ids.map((id) => `https://heyresearch.xyz/e/${id}`) });
  }
  return json(404, { error: 'not_found' });
}

// ------------------------------------------------------------------ mocked NEAR: the escrow's rules, the token, the RPC
const ME = 'funder.near', ALICE = 'alice.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const near = { bounties: [], contrib: new Map(), usdc: new Map(), txs: [], views: [], events: [], pending: [], txApi: true };
const nearEvent = (event, data) => near.pending.push(`EVENT_JSON:${JSON.stringify({ standard: 'hey-proof-of-ship', version: '1.0.0', event, data: [data] })}`);
/** One NEAR transaction as FastNear's transactions API keeps it: its hash, its time and the escrow's event logs. */
const nearTx = (hash, at, receiver) => { near.events.push({ hash, at, receiver, logs: near.pending.splice(0) }); };
const bal = (a) => near.usdc.get(a) ?? 0n;
const addBal = (a, v) => near.usdc.set(a, bal(a) + v);
function seedNear() {
  near.bounties = []; near.contrib = new Map(); near.usdc = new Map([[ME, 500_000_000n]]); near.txs = []; near.views = []; near.events = []; near.pending = []; near.txApi = true;
  const t = NOW();
  const mk = (slug, creator, start, deadline, minShips, funder, amount) => {
    const id = near.bounties.length;
    near.bounties.push({ id, slug, builder: TIES[slug].toLowerCase(), creator, start, deadline, min_ships: minShips, payout: 'near', status: 'open', total: amount, paid_out: 0n, funders: 1, ships: 0, evidence: null, failed_payouts: 0 });
    near.contrib.set(`${id}:${funder}`, amount);
    addBal(NEAR_ESCROW, amount);
    nearEvent('bounty_created', { id, slug, builder: TIES[slug].toLowerCase(), creator, min_ships: minShips, start, deadline, payout: 'near' });
    nearTx(`${'3'.repeat(40)}${String(id * 2 + 1).padStart(4, '4')}`, start, NEAR_ESCROW);
    nearEvent('funded', { id, funder, amount: String(amount), total: String(amount) });
    nearTx(`${'3'.repeat(40)}${String(id * 2 + 2).padStart(4, '4')}`, start + 60, USDC);
  };
  mk('fly-ai', ME, t - 30 * DAY, t - 10 * DAY, 3, ME, 50_000_000n); // past the deadline plus grace: refundable
  mk('predict-fwa', ALICE, t - 2 * DAY, t + 5 * DAY, 3, ALICE, 100_000_000n); // target met: claimable
}
const viewOf = (b) => ({ ...b, project: keccak256(stringToBytes(b.slug)), builder_account: b.builder, refunds_open_at: b.deadline + GRACE + 1, total: String(b.total), paid_out: String(b.paid_out) });
const enc = (v) => [...Buffer.from(JSON.stringify(v))];
async function nearView(account, method, args) {
  near.views.push(method);
  if (account === USDC && method === 'ft_balance_of') return String(bal(args.account_id));
  if (account !== NEAR_ESCROW) throw new Error(`no view ${account}.${method}`);
  switch (method) {
    case 'get_config': return { attester: attester.address.toLowerCase(), token: USDC, chain_id: 397, salt: nearDomain.salt, domain_separator: domainSeparator({ domain: nearDomain }), guardian: 'heyresearch.near', intents: 'intents.near', token_storage_deposit: '1250000000000000000000', retired: false, max_attestation_age: 86400, claim_grace: GRACE, min_duration: DAY, max_duration: 365 * DAY };
    case 'bounty_count': return near.bounties.length;
    case 'get_bounties': { const from = args.from_index ?? 0; return near.bounties.slice(from, from + Math.min(args.limit ?? 50, 50)).map(viewOf); }
    case 'get_bounty': return near.bounties[args.id] ? viewOf(near.bounties[args.id]) : null;
    case 'get_contribution': return String(near.contrib.get(`${args.id}:${args.account_id}`) ?? 0n);
    case 'recover_signer': {
      const a = args.attestation;
      const signer = await recoverTypedDataAddress({ domain: nearDomain, types: SHIPS_TYPES, primaryType: 'Ships', message: { ...a, since: BigInt(a.since), until: BigInt(a.until), issuedAt: BigInt(a.issuedAt) }, signature: args.signature });
      return { signer: signer.toLowerCase(), is_attester: signer === attester.address, error: null, digest: hashTypedData({ domain: nearDomain, types: SHIPS_TYPES, primaryType: 'Ships', message: { ...a, since: BigInt(a.since), until: BigInt(a.until), issuedAt: BigInt(a.issuedAt) } }) };
    }
    default: throw new Error(`no view ${method}`);
  }
}
const panic = (code) => { const e = new Error(code); e.panic = true; throw e; };
async function nearExec(tx) {
  const signer = tx.signerId, a = tx.actions[0].params, args = a.args, gas = BigInt(a.gas), deposit = BigInt(a.deposit);
  near.txs.push({ receiverId: tx.receiverId, method: a.methodName, args, gas, deposit, signer });
  const t = NOW();
  if (tx.receiverId === NEAR_ESCROW && a.methodName === 'create') {
    if (deposit < 10n ** 22n) panic('ERR_STORAGE');
    if (!(args.deadline >= t + DAY && args.deadline <= t + 365 * DAY)) panic('ERR_BAD_DEADLINE');
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(args.slug)) panic('ERR_BAD_SLUG');
    const id = near.bounties.length;
    near.bounties.push({ id, slug: args.slug, builder: args.builder.toLowerCase(), creator: signer, start: t, deadline: args.deadline, min_ships: args.min_ships, payout: args.payout ?? 'near', status: 'open', total: 0n, paid_out: 0n, funders: 0, ships: 0, evidence: null, failed_payouts: 0 });
    nearEvent('bounty_created', { id, slug: args.slug, builder: args.builder.toLowerCase(), creator: signer, min_ships: args.min_ships, start: t, deadline: args.deadline, payout: args.payout ?? 'near' });
    return id;
  }
  if (tx.receiverId === USDC && a.methodName === 'ft_transfer_call') {
    if (deposit !== 1n) panic('Requires attached deposit of exactly 1 yoctoNEAR');
    const amount = BigInt(args.amount);
    if (bal(signer) < amount) panic('The account does not have enough balance');
    let msg; try { msg = JSON.parse(args.msg); } catch { return '0'; }
    const b = near.bounties[msg.id];
    if (args.receiver_id !== NEAR_ESCROW || msg.action !== 'fund' || !b || b.status !== 'open' || t >= b.deadline) return '0';
    addBal(signer, -amount); addBal(NEAR_ESCROW, amount);
    const key = `${b.id}:${signer}`;
    if (!near.contrib.has(key)) b.funders++;
    near.contrib.set(key, (near.contrib.get(key) ?? 0n) + amount);
    b.total += amount;
    nearEvent('funded', { id: b.id, funder: signer, amount: String(amount), total: String(b.total) });
    return String(amount);
  }
  if (tx.receiverId === NEAR_ESCROW && a.methodName === 'claim') {
    const b = near.bounties[args.id], at = args.attestation;
    if (!b) panic('ERR_UNKNOWN_BOUNTY');
    if (b.status !== 'open') panic('ERR_ALREADY_CLAIMED');
    if (t > b.deadline + GRACE) panic('ERR_CLAIM_CLOSED');
    if (gas < 100n * 10n ** 12n) panic('ERR_GAS');
    if (b.payout === 'near' && deposit < 1250000000000000000000n) panic('ERR_STORAGE_DEPOSIT');
    if (at.project !== keccak256(stringToBytes(b.slug))) panic('ERR_WRONG_PROJECT');
    if (at.builder.toLowerCase() !== b.builder) panic('ERR_WRONG_BUILDER');
    if (!(Number(at.since) === b.start && Number(at.until) <= b.deadline && Number(at.until) <= Number(at.issuedAt))) panic('ERR_WRONG_WINDOW');
    if (Number(at.issuedAt) > t || t - Number(at.issuedAt) > DAY) panic('ERR_STALE_ATTESTATION');
    if (Number(at.ships) < b.min_ships) panic('ERR_NOT_ENOUGH_SHIPS');
    const { is_attester } = await nearView(NEAR_ESCROW, 'recover_signer', { attestation: at, signature: args.signature });
    if (!is_attester) panic('ERR_WRONG_SIGNER');
    b.status = 'paid'; b.paid_out = b.total; b.ships = Number(at.ships); b.evidence = at.evidence;
    nearEvent('claimed', { id: b.id, builder: b.builder, route: b.payout, paid: String(b.total), ships: Number(at.ships), evidence: at.evidence });
    addBal(NEAR_ESCROW, -b.total); addBal(b.builder, b.total);
    return true;
  }
  if (tx.receiverId === NEAR_ESCROW && a.methodName === 'refund') {
    const b = near.bounties[args.id];
    if (b.status !== 'open') panic('ERR_ALREADY_CLAIMED');
    if (!(t > b.deadline + GRACE)) panic('ERR_REFUND_NOT_OPEN');
    const key = `${b.id}:${signer}`, amount = near.contrib.get(key) ?? 0n;
    if (amount === 0n) panic('ERR_NOTHING_TO_REFUND');
    near.contrib.delete(key); b.total -= amount; b.funders--;
    nearEvent('refunded', { id: b.id, funder: signer, amount: String(amount) });
    addBal(NEAR_ESCROW, -amount); addBal(signer, amount);
    return true;
  }
  panic(`no method ${tx.receiverId}.${a.methodName}`);
}
let txn = 0;
const fakeHash = () => `${'1'.repeat(40)}${String(++txn).padStart(4, '2')}`.replace(/0/g, '2');
async function nearSend(tx) {
  try {
    near.pending = [];
    const value = await nearExec(tx);
    const hash = fakeHash();
    nearTx(hash, NOW(), tx.receiverId);
    return { status: { SuccessValue: Buffer.from(JSON.stringify(value)).toString('base64') }, transaction: { hash } };
  } catch (e) {
    near.pending = [];
    if (!e.panic) throw e;
    return { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${e.message}` } } } } }, transaction: { hash: fakeHash() } };
  }
}
async function nearRpc(route) {
  const body = JSON.parse(route.request().postData() ?? '{}');
  const reply = (result) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  if (body.method === 'query' && body.params.request_type === 'view_access_key_list') return reply({ keys: [{ public_key: 'ed25519:test', access_key: { nonce: 1, permission: 'FullAccess' } }] });
  if (body.method === 'block') return reply({ header: { timestamp: String(BigInt(NOW()) * 1_000_000_000n), height: 1 } });
  if (body.method === 'query' && body.params.request_type === 'call_function') {
    const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString() || '{}');
    try { return reply({ result: enc(await nearView(body.params.account_id, body.params.method_name, args)), logs: [], block_height: 1 }); } catch (e) { return reply({ error: String(e.message), logs: [] }); }
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: 'not mocked' } }) });
}

/** FastNear's public transactions API: the escrow's transactions, newest first, and each one's receipts and logs. */
async function nearTxApi(route) {
  const u = new URL(route.request().url());
  const body = JSON.parse(route.request().postData() ?? '{}');
  const json = (status, b) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
  if (!near.txApi) return json(503, { error: 'unavailable' });
  if (near.txApiFailures > 0) { near.txApiFailures--; return json(403, { error: 'busy' }); }
  if (u.pathname === '/v0/account' && body.account_id === NEAR_ESCROW) {
    const txs = [...near.events].sort((a, b) => b.at - a.at).map((e, i) => ({ account_id: NEAR_ESCROW, transaction_hash: e.hash, tx_block_height: 1000 + i, tx_block_timestamp: String(BigInt(e.at) * 1_000_000_000n), is_success: true }));
    return json(200, { account_txs: txs, txs_count: txs.length });
  }
  if (u.pathname === '/v0/transactions') {
    const want = new Set(body.tx_hashes ?? []);
    return json(200, { transactions: near.events.filter((e) => want.has(e.hash)).map((e) => ({ transaction: { hash: e.hash, signer_id: 'x.near', receiver_id: e.receiver }, receipts: [{ receipt: { receiver_id: NEAR_ESCROW }, execution_outcome: { outcome: { logs: e.logs } } }] })) });
  }
  return json(404, { error: 'not mocked' });
}

// ------------------------------------------------------------------ mocked Robinhood Chain
const ABI = JSON.parse(fs.readFileSync(path.join(APP, 'ShipEscrow.abi.json'), 'utf8'));
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const WIF = '0x5173b8eA6923c2d40267890D45C46a3480954773';
const RH_ME = '0x1111111111111111111111111111111111111111';
const rh = { sent: [], logReads: [] };
function rhBounties() {
  const t = NOW();
  return [
    { token: WIF, builder: TIES['predict-fwa'], project: keccak256(stringToBytes('predict-fwa')), start: BigInt(t - 20 * DAY), deadline: BigInt(t - 10 * DAY), minShips: 3, burnBps: 200, paid: true, total: 5000n * 10n ** 18n, slug: 'predict-fwa' },
    { token: WIF, builder: TIES['fly-ai'], project: keccak256(stringToBytes('fly-ai')), start: BigInt(t - 2 * DAY), deadline: BigInt(t + 8 * DAY), minShips: 3, burnBps: 200, paid: false, total: 5000n * 10n ** 18n, slug: 'fly-ai' },
  ];
}
function rhCall(to, data) {
  const bs = rhBounties();
  if (to.toLowerCase() === WIF.toLowerCase()) {
    const { functionName, args } = decodeFunctionData({ abi: ERC20, data });
    const v = functionName === 'balanceOf' ? (args[0].toLowerCase() === RH_ESCROW.toLowerCase() ? 5000n * 10n ** 18n : 10_000n * 10n ** 18n) : 0n;
    return encodeFunctionResult({ abi: ERC20, functionName, result: v });
  }
  const { functionName, args } = decodeFunctionData({ abi: ABI, data });
  const r = { bountyCount: 2n, retired: false, contributed: 0n, attester: attester.address, domainSeparator: domainSeparator({ domain: rhDomain }) }[functionName];
  if (functionName === 'digest') { const a = args[0]; return encodeFunctionResult({ abi: ABI, functionName, result: hashTypedData({ domain: rhDomain, types: SHIPS_TYPES, primaryType: 'Ships', message: a }) }); }
  if (r !== undefined) return encodeFunctionResult({ abi: ABI, functionName, result: r });
  if (functionName === 'bounty') { const { slug, ...b } = bs[Number(args[0])]; return encodeFunctionResult({ abi: ABI, functionName, result: b }); }
  if (functionName === 'slugOf') return encodeFunctionResult({ abi: ABI, functionName, result: bs[Number(args[0])].slug });
  throw new Error(`rh call ${functionName}`);
}
/** ShipEscrow's events for the two bounties, as eth_getLogs answers them: #0 opened, funded, released; #1 opened, funded. */
const RH_FROM = 96136035;
function rhLogs() {
  const t = NOW();
  const bs = rhBounties();
  const ev = [];
  const log = (block, at, eventName, args, i) => {
    const item = ABI.find((x) => x.type === 'event' && x.name === eventName);
    // Each indexed argument as its own topic (encodeEventTopics drops an id of 0n as if it were missing).
    const topics = [encodeEventTopics({ abi: ABI, eventName })[0], ...item.inputs.filter((x) => x.indexed).map((x) => encodeAbiParameters([x], [args[x.name]]))];
    const data = encodeAbiParameters(item.inputs.filter((x) => !x.indexed), item.inputs.filter((x) => !x.indexed).map((x) => args[x.name]));
    ev.push({ address: RH_ESCROW.toLowerCase(), topics, data, blockNumber: `0x${block.toString(16)}`, transactionHash: `0x${String(block).padStart(8, '0')}${'cd'.repeat(28)}`, transactionIndex: '0x0', blockHash: `0x${'ef'.repeat(32)}`, logIndex: `0x${i.toString(16)}`, removed: false, at });
  };
  bs.forEach((b, id) => {
    const blk = RH_FROM + 1000 + id * 1000;
    const start = Number(b.start);
    log(blk, start, 'BountyCreated', { id: BigInt(id), token: WIF, builder: b.builder, project: b.project, slug: b.slug, minShips: b.minShips, start: b.start, deadline: b.deadline, burnBps: b.burnBps }, 0);
    log(blk, start, 'Funded', { id: BigInt(id), funder: RH_ME, amount: b.total, total: b.total }, 1);
    if (b.paid) log(blk + 500, Number(b.deadline) - 3600, 'Claimed', { id: BigInt(id), builder: b.builder, paid: b.total - b.total / 50n, burned: b.total / 50n, ships: 3, evidence: `0x${'11'.repeat(32)}` }, 0);
  });
  return ev;
}
const rhBlockTime = (n) => rhLogs().find((l) => Number(l.blockNumber) === n)?.at ?? NOW();
async function rhRpc(route) {
  const body = JSON.parse(route.request().postData() ?? '{}');
  const one = (q) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
    if (q.method === 'eth_chainId') return ok('0x1237');
    if (q.method === 'eth_blockNumber') return ok(`0x${(RH_FROM + 3_000_000).toString(16)}`);
    if (q.method === 'eth_getBlockByNumber') {
      const n = /^0x/.test(String(q.params[0])) ? Number(q.params[0]) : null;
      return ok({ number: q.params[0] === 'latest' ? `0x${(RH_FROM + 3_000_000).toString(16)}` : q.params[0], timestamp: `0x${(n === null ? NOW() : rhBlockTime(n)).toString(16)}`, hash: `0x${'ab'.repeat(32)}`, transactions: [] });
    }
    if (q.method === 'eth_getLogs') {
      const f = q.params[0];
      rh.logReads.push(f);
      // Robinhood Chain's node: 2,000,000 blocks a request with no topics, 100,000 with a list of topics in a position.
      const span = Number(f.toBlock) - Number(f.fromBlock) + 1;
      const listed = (f.topics ?? []).some((x) => Array.isArray(x) && x.length > 1);
      if (span > (listed ? 100_000 : 2_000_000)) return { jsonrpc: '2.0', id: q.id, error: { code: -32602, message: `query spans ${span} blocks, but only ${listed ? 100000 : 2000000} are allowed for this request` } };
      return ok(rhLogs().filter((l) => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock)).map(({ at, ...l }) => l));
    }
    if (q.method === 'eth_call') { try { return ok(rhCall(q.params[0].to, q.params[0].data)); } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } }
    return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: `not mocked ${q.method}` } };
  };
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
}

// ------------------------------------------------------------------ the browser
const browser = await chromium.launch();
const live = [];
async function newPage({ width = 1280, height = 900, scheme = 'light', timezoneId = 'UTC' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, timezoneId });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  // The page's configs, with the public test attester in place of HEY's: the only change made to what the page loads.
  await page.route(/\/(near-)?config\.js(\?|$)/, async (route) => {
    const res = await route.fetch();
    const text = (await res.text()).replace(/attester: '0x[0-9a-fA-F]{40}'/, `attester: '${attester.address}'`);
    await route.fulfill({ response: res, body: text, headers: { ...res.headers(), 'content-type': 'text/javascript' } });
  });
  // Anything not mocked below is refused: the checks never reach a live host.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => { live.push(r.request().url()); return r.abort(); });
  await page.route('https://heyresearch.xyz/**', heyRoute);
  await page.route('https://tx.main.fastnear.com/**', nearTxApi);
  await page.route(/https:\/\/(free\.rpc\.fastnear\.com|rpc\.mainnet\.near\.org)\/?.*/, nearRpc);
  await page.route('https://rpc.mainnet.chain.robinhood.com/**', rhRpc);
  await page.route(/https:\/\/(wallet\.meteorwallet\.app|app\.mynearwallet\.com)\/.*/, (r) => r.abort());
  await page.exposeFunction('__posNearSend', (tx) => nearSend(tx));
  await page.exposeFunction('__posRhSend', (req) => { rh.sent.push(req); });
  await page.addInitScript(([me, rhMe]) => {
    // A NEAR test wallet (the page reads it only on localhost / 127.0.0.1).
    window.__posNearTestWallet = {
      name: 'Test wallet',
      signIn: async () => { sessionStorage.setItem('tw', '1'); return [{ accountId: me }]; },
      getAccounts: async () => (sessionStorage.getItem('tw') ? [{ accountId: me }] : []),
      signOut: async () => sessionStorage.removeItem('tw'),
      signAndSendTransaction: (tx) => window.__posNearSend(tx),
    };
    // An EIP-1193 wallet on Robinhood Chain that refuses to sign: the request it was asked to sign is recorded.
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [rhMe];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') { await window.__posRhSend(params[0]); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
        throw Object.assign(new Error(`not mocked ${method}`), { code: 4200 });
      },
    };
  }, [ME, RH_ME]);
  return { page, ctx, errors };
}
const text = (page, sel) => page.locator(sel).first().innerText().catch(() => '');
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
// The page's own date words, rebuilt here to check what it shows against what it sends.
function whenText(s, timeZone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(s * 1000)).map((p) => [p.type, p.value]));
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}
const pad2 = (n) => String(n).padStart(2, '0');
const utcShort = (s) => { const d = new Date(s * 1000); return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; };
const dayMonth = (s) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const xPost = async (page, sel) => { const href = await page.getAttribute(sel, 'href'); return href ? new URL(href).searchParams.get('text') : null; };
const minutesOf = (t) => { const m = /^(?:(\d+)d )?(?:(\d+)h )?(\d+)m$/.exec(t); return m ? Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3]) : NaN; };
/** Scroll a card into view by its id: a card is redrawn when HEY answers, so a held locator can go stale. */
const reveal = (page, sel) => page.evaluate((q) => document.querySelector(q)?.scrollIntoView({ block: 'center' }), sel);
const noSideScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth);
async function pick(page, input, q) {
  await page.fill(input, '');
  await page.type(input, q, { delay: 20 });
  await until(async () => (await page.locator(`${input} ~ ul [role="option"]`).count()) > 0);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

// ================================================================== Robinhood Chain: unchanged
{
  console.log('\n# Robinhood Chain (default)');
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/`);
  check(await page.isVisible('#open'), 'the Robinhood Chain form is shown by default');
  check(await page.isHidden('#nearView'), 'the NEAR view is hidden by default');
  check((await page.getAttribute('#chainSwitch [data-pick="robinhood"]', 'aria-pressed')) === 'true', 'the switch reads Robinhood Chain');
  check(await until(async () => (await text(page, '#sOpen')) === '1'), 'stats read from the escrow: 1 open bounty');
  check((await text(page, '#sLocked')).startsWith('5,000'), 'stats: 5,000 WIF locked');
  check(await until(async () => /Paid out/.test(await text(page, '#bounty-0'))), 'bounty #0 reads Paid out');
  await page.locator('#bounty-1').scrollIntoViewIfNeeded();
  check(await until(async () => /1 of 3 ships counted/.test(await text(page, '#bounty-1'))), 'bounty #1 reads HEY’s signed count, 1 of 3');
  await page.evaluate(() => window.scrollTo(0, 0));
  await pick(page, '#slug', 'predict');
  check(await until(async () => (await page.inputValue('#builder')) === TIES['predict-fwa']), 'picking predict FWA fills the payout address from the tie route');
  check(await until(async () => /HEY ties this address/.test(await text(page, '#builderHint'))), 'HEY’s Robinhood Chain signature for it checks out');
  await page.click('#connect');
  await page.click('#walletList [data-uuid="injected"]').catch(() => undefined);
  check(await until(async () => (await text(page, '#account')).includes('0x1111')), 'an injected wallet connects');
  await page.click('#openBtn');
  check(await until(() => rh.sent.length > 0), 'Open asks the wallet to sign');
  const sent = rh.sent[0];
  let approve = null;
  try { approve = decodeFunctionData({ abi: ERC20, data: sent.data }); } catch { /* checked below */ }
  check(sent?.to?.toLowerCase() === WIF.toLowerCase() && approve?.functionName === 'approve' && approve.args[0].toLowerCase() === RH_ESCROW.toLowerCase() && approve.args[1] === 5000n * 10n ** 18n, 'the first prompt is approve(escrow, 5,000 WIF), as before');
  check(await until(async () => /rejected/i.test(await text(page, '#toast'))), 'the refusal is said in a toast');
  await page.screenshot({ path: path.join(SHOTS, 'robinhood-desktop-light.png'), fullPage: false });
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ================================================================== NEAR: HEY not signing for NEAR yet
seedNear();
{
  console.log('\n# NEAR, before HEY signs for the NEAR escrow');
  hey.nearLive = false;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/`);
  await page.click('#chainSwitch [data-pick="near"]');
  check(page.url().includes('chain=near'), 'the switch writes ?chain=near');
  check(await page.isVisible('#nearView') && await page.isHidden('#open'), 'NEAR is shown and Robinhood Chain hidden');
  check(await until(async () => (await text(page, '#nsCount')) === '2'), 'the escrow’s bounty_count reads 2');
  check(await until(async () => /still holds 1 full-access key/.test(await text(page, '#nKeys'))), 'the trust card says the account still holds 1 full-access key');
  check((await text(page, '#nsLocked')).startsWith('150'), 'USDC in the escrow: 150 (ft_balance_of)');
  check(await until(async () => await page.isVisible('#nSigning')), 'a banner says HEY is not signing for NEAR yet');
  check(await until(async () => /HEY not signing for NEAR yet/.test(await text(page, '#near-bounty-1'))), 'the open bounty says so instead of a count');
  await pick(page, '#nSlug', 'predict');
  check(await until(async () => (await page.inputValue('#nBuilder')) === TIES['predict-fwa']), 'the payout address fills in from the tie route');
  check(await until(async () => /not signing for the NEAR escrow/.test(await text(page, '#nBuilderHint'))), 'the payout hint says HEY is not signing for NEAR');
  check((await text(page, '#nAccountOut')).toLowerCase().includes('0x4209'), 'the preview names the eth-implicit NEAR account');
  await page.click('#nOpenBtn');
  await page.waitForTimeout(800);
  check(near.txs.length === 0, 'Open sends nothing while HEY is not signing');
  check(!(await page.evaluate(() => document.querySelector('#nConfirm').open)), 'and shows no confirmation for a payout HEY cannot sign');
  await page.screenshot({ path: path.join(SHOTS, 'near-not-signing-desktop-light.png'), fullPage: false });
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ================================================================== NEAR: the whole flow
{
  console.log('\n# NEAR, HEY signing');
  hey.nearLive = true;
  const ZONE = 'Asia/Kuala_Lumpur';
  const { page, ctx, errors } = await newPage({ timezoneId: ZONE });
  await page.goto(`${BASE}/?chain=near`);
  check(await page.isVisible('#nearView'), '?chain=near opens on NEAR');
  check(await until(async () => /Target met/.test(await text(page, '#near-bounty-1'))), 'bounty #1: HEY counts 3 of 3, target met');
  check(await page.isHidden('#nSigning'), 'no “not signing” banner');
  check((await page.locator('#near-bounty-1 .ships a', { hasText: 'evidence' }).count()) === 3, 'three evidence links on the card');
  check(/Closed/.test(await text(page, '#near-bounty-0')), 'bounty #0: closed, funders can take back');

  // Countdown and timeline on the card.
  const b1 = near.bounties[1];
  check((await text(page, '#near-bounty-1 [data-ncount] .k')) === 'Time left to ship' && /^4d 23h 5\dm$/.test(await text(page, '#near-bounty-1 [data-ncount] .v')), `bounty #1 counts down: ${await text(page, '#near-bounty-1 [data-ncount] .v')} left to ship`);
  check((await text(page, '#near-bounty-1 [data-when="ship"]')) === utcShort(b1.deadline), `Ship by ${utcShort(b1.deadline)}`);
  check((await text(page, '#near-bounty-1 [data-when="claim"]')) === utcShort(b1.deadline + GRACE), `Claim until ${utcShort(b1.deadline + GRACE)} (deadline plus 3 days)`);
  check((await text(page, '#near-bounty-1 [data-when="refund"]')) === utcShort(b1.deadline + GRACE + 1), 'Refunds from the end of the claim window');
  check((await text(page, '#near-bounty-0 [data-ncount] .v')) === 'Closed', 'bounty #0’s countdown reads Closed');
  const counted = await page.locator('#near-bounty-1 .counted .ships li').allInnerTexts();
  const countedLinks = await page.locator('#near-bounty-1 .counted .ships a', { hasText: 'evidence' }).evaluateAll((as) => as.map((a) => a.href));
  check(/counted so far, 3 since/.test(await text(page, '#near-bounty-1 .counted .k')) && counted.length === 3 && /^Release · v1\.4\.0/.test(counted[0]), 'the card lists the 3 ships HEY counted so far, with their titles');
  check(countedLinks.length === 3 && countedLinks.every((h) => /^https:\/\/heyresearch\.xyz\/e\/ship:/.test(h)), 'each counted ship links to its evidence');

  // Post on X.
  const post1 = await xPost(page, '#near-bounty-1 [data-nx]');
  check(post1 === `I'm backing predict FWA on NEAR: 100 USDC if they ship 3 times by ${dayMonth(b1.deadline)}. Released only when @HeyResearch counts the ships on chain. #NEARHackathon https://hey-research-lab.github.io/proof-of-ship/?chain=near#near-bounty-1`, `Post on X opens the ready post: “${post1}”`);
  check(post1 !== null && post1.length <= 280 && !/[—–]/.test(post1), `the post is ${post1?.length} characters, under 280, with no dash`);
  check((await page.getAttribute('#near-bounty-1 [data-nx]', 'href')).startsWith('https://x.com/intent/post?text=') && (await page.getAttribute('#near-bounty-1 [data-nx]', 'target')) === '_blank', 'it is an X intent link opening in a new tab');
  check((await page.locator('#near-bounty-0 [data-nx]').count()) === 0, 'a closed bounty offers no post');
  await page.locator('#near-bounty-1').screenshot({ path: path.join(SHOTS, 'near-card-desktop-light.png') });

  await page.click('#nConnect');
  await page.click('#nearWalletList [data-wallet="test"]');
  check(await until(async () => (await text(page, '#nAccount')).includes('funder.near')), 'the NEAR wallet connects');
  check(await until(async () => (await text(page, '#nAccount')).includes('500')), 'and shows its 500 USDC');

  check(await until(async () => /Take back 50 USDC/.test(await text(page, '#near-bounty-0'))), 'bounty #0 offers Take back 50 USDC to its funder');
  await page.click('#near-bounty-0 [data-nact="refund"]');
  check(await until(() => near.txs.some((t) => t.method === 'refund')), 'Take back sends refund(id)');
  const refund = near.txs.find((t) => t.method === 'refund');
  check(refund.receiverId === NEAR_ESCROW && refund.args.id === 0 && refund.deposit === 0n, 'refund(0) to the escrow, no deposit');
  check(bal(ME) === 550_000_000n, 'the 50 USDC is back with the funder');
  check(await until(async () => (await page.locator('#near-bounty-0').count()) === 0), 'the refunded, empty bounty #0 leaves the list');
  check(await until(async () => /Refunded/.test(await text(page, '#toast')) && !(await page.evaluate(() => document.querySelector('#nCreate').inert))), 'the page says Refunded and frees the form');

  await pick(page, '#nSlug', 'predict');
  check(await until(async () => /HEY ties this address/.test(await text(page, '#nBuilderHint'))), 'HEY’s NEAR signature for the payout address checks out');
  if (!/HEY ties this address/.test(await text(page, '#nBuilderHint'))) console.log('   hint:', await text(page, '#nBuilderHint'), '| slug:', await page.inputValue('#nSlug'), '| builder:', await page.inputValue('#nBuilder'), '| toast:', await text(page, '#toast'), '| last att:', JSON.stringify(hey.attestations.at(-1)));
  check(await until(async () => /HEY will pay this address/.test(await text(page, '#nTieBox'))), 'the tie box says HEY will pay it');

  // Realistic-target hint: HEY's count of the last 14 days, against the target.
  check(await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace').catch(() => null)) === 'likely'), 'the hint reads likely for 3 ships in 14 days');
  check(/By HEY’s count, predict FWA shipped 10 times in the last 14 days \(about 5 a week\)\. A target of 3 in 14 days looks likely\./.test(await text(page, '#nPace')), `the hint says it plainly: “${(await text(page, '#nPace')).split('\n')[0]}”`);
  check(/at most one ship of each kind a day, and a code week only once that week has ended/.test(await text(page, '#nPace')), 'and says how HEY counts in one line');
  const sc = hey.shipsCalls.at(-1);
  check(sc?.slug === 'predict-fwa' && Number(sc.until) - Number(sc.since) === 14 * DAY && Number(sc.until) <= NOW() && Number(sc.until) % 3600 === 0, 'it asked the ships route for the last 14 closed days, cut to the hour');
  await page.fill('#nMinShips', '10');
  check(await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace')) === 'tight'), 'a target of 10 in 14 days reads tight');
  await page.fill('#nMinShips', '30');
  check(await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace')) === 'unlikely'), 'a target of 30 in 14 days reads unlikely');
  await page.fill('#nMinShips', '10');
  await page.click('#nDaysPresets [data-days="30"]');
  check(await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace')) === 'likely' && /10 in 30 days/.test(await text(page, '#nPace'))), 'and 10 in 30 days reads likely: the days count too');
  await page.click('#nDaysPresets [data-days="14"]');
  await page.fill('#nMinShips', '3');
  const callsBefore = hey.shipsCalls.length;
  await pick(page, '#nSlug', 'quiet');
  check(await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace').catch(() => null)) === 'null'), 'a project HEY cannot measure gets no verdict');
  check(/HEY can’t measure Quiet Labs’s shipping right now\. HEY does not measure this project’s building right now: no builder source it reads\./.test(await text(page, '#nPace')) && !/shipped 0/.test(await text(page, '#nPace')), 'it says HEY can’t measure it, with HEY’s reason, never 0');
  check(hey.shipsCalls.length === callsBefore + 1, 'one ships call for the new project');
  await page.screenshot({ path: path.join(SHOTS, 'near-pace-null-desktop-light.png'), fullPage: false });
  await pick(page, '#nSlug', 'predict');
  check(await until(async () => (await page.inputValue('#nBuilder')) === TIES['predict-fwa'] && /HEY ties this address/.test(await text(page, '#nBuilderHint'))), 'back on predict FWA, its payout address checks out again');
  check(await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace').catch(() => null)) === 'likely') && hey.shipsCalls.length === callsBefore + 1, 'and its hint comes back from the page’s cache, no second call');
  await page.fill('#nAmount', '25');
  await page.click('#nPayoutSeg [data-payout="intents"]');
  check(/NEAR Intents/.test(await text(page, '#nRoute')), 'the preview reads NEAR Intents');
  await page.screenshot({ path: path.join(SHOTS, 'near-open-desktop-light.png'), fullPage: false });
  const dialogOpen = () => page.evaluate(() => document.querySelector('#nConfirm').open);

  // 1. Go back: nothing is sent.
  await page.click('#nOpenBtn');
  check(await until(dialogOpen), 'Open bounty first shows a confirmation');
  await page.click('#nConfirmNo');
  check(await until(async () => !(await dialogOpen()) && /Nothing was sent/.test(await text(page, '#toast'))), 'Go back closes it and says nothing was sent');
  check(!near.txs.some((t) => t.method === 'create'), 'no create after Go back');

  // 2. The days field moves under the open summary (as a browser refill would): refused at confirm.
  await page.click('#nOpenBtn');
  check(await until(dialogOpen), 'the confirmation opens again');
  await page.evaluate(() => { document.querySelector('#nDays').value = '1'; });
  await page.click('#nConfirmYes');
  check(await until(async () => /days field now holds 1, not the 14/.test(await text(page, '#toast'))), 'a days field that changed after the summary is refused at confirm');
  check(!near.txs.some((t) => t.method === 'create'), 'and nothing is sent');
  check(await until(async () => (await page.getAttribute('#nDaysPresets [data-days="custom"]', 'aria-pressed')) === 'true' && await page.isVisible('#nDays') && (await page.inputValue('#nDays')) === '1'), 'the form then shows the 1 it holds under Custom, never behind “14 days”');
  check(/1 day$/.test(await text(page, '#nBy')), 'and the preview says 1 day');

  // 3. The real thing: the summary shows the exact deadline, and that number is sent.
  await page.click('#nDaysPresets [data-days="14"]');
  await page.click('#nOpenBtn');
  check(await until(dialogOpen), 'the confirmation opens with 14 days');
  const shownDeadline = Number(await page.getAttribute('#nConfirm', 'data-deadline'));
  const confirmText = await text(page, '#nConfirm');
  check(/You’re locking 25 USDC for predict FWA\./.test(confirmText), 'it says “You’re locking 25 USDC for predict FWA.”');
  check(confirmText.includes(`predict FWA must ship 3 times by ${whenText(shownDeadline)} UTC`), `it says “must ship 3 times by ${whenText(shownDeadline)} UTC”`);
  check(confirmText.includes(`${whenText(shownDeadline, ZONE)} in your time zone, ${ZONE}`), `and the same time in the reader’s zone: ${whenText(shownDeadline, ZONE)} (${ZONE})`);
  check(confirmText.includes(`Claimable until ${whenText(shownDeadline + GRACE)} UTC. If not, funders take it back from ${whenText(shownDeadline + GRACE + 1)} UTC.`), 'claimable until the deadline plus 3 days, refunds after');
  check(confirmText.includes(`${shownDeadline} (unix seconds`), 'it prints the deadline number the wallet will show');
  check(!/[—–]/.test(await page.locator('#nConfirm p').allInnerTexts().then((a) => a.join(' '))), 'its sentences carry no dash');
  await page.screenshot({ path: path.join(SHOTS, 'near-confirm-desktop-light.png'), fullPage: false });
  await page.click('#nConfirmYes');
  check(await until(() => near.txs.some((t) => t.method === 'create')), 'Confirm sends create');
  const create = near.txs.find((t) => t.method === 'create');
  check(create.args.deadline === shownDeadline, `the deadline sent (${create.args.deadline}) is exactly the one shown (${shownDeadline})`);
  const days = (create.args.deadline - NOW()) / DAY;
  check(create.receiverId === NEAR_ESCROW && create.args.slug === 'predict-fwa' && create.args.builder.toLowerCase() === TIES['predict-fwa'].toLowerCase() && create.args.min_ships === 3 && create.args.payout === 'intents' && days > 14 && days < 14.1, 'create(builder, slug, 3, deadline about 14 days on, intents)');
  check(create.deposit === 10n ** 22n && create.gas === 30n * 10n ** 12n, 'create attaches 0.01 NEAR and 30 TGas');
  check(await until(async () => /Fund #2 with 25 USDC/.test(await text(page, '#nFundBtn'))), 'step 2 appears: Fund #2 with 25 USDC');
  await page.click('#nFundBtn');
  check(await until(() => near.txs.some((t) => t.method === 'ft_transfer_call')), 'Fund sends ft_transfer_call');
  const fund = near.txs.find((t) => t.method === 'ft_transfer_call');
  check(fund.receiverId === USDC && fund.args.receiver_id === NEAR_ESCROW && fund.args.amount === '25000000' && fund.args.msg === '{"action":"fund","id":2}' && fund.deposit === 1n && fund.gas === 100n * 10n ** 12n, 'ft_transfer_call to USDC: 25 USDC, msg {"action":"fund","id":2}, 1 yoctoNEAR, 100 TGas');
  check(await until(async () => /25 USDC/.test(await text(page, '#near-bounty-2 .facts'))), 'bounty #2 shows 25 USDC locked');
  check(await page.isHidden('#nFundStep'), 'the step-2 box is gone');

  await page.click('#near-bounty-1 [data-nact="claim"]');
  check(await until(async () => /HEY counts 3 ships/.test(await text(page, '#near-bounty-1 .claimbox'))), 'Release shows “HEY counts 3 ships” before sending');
  check(near.views.includes('recover_signer'), 'and asked the escrow’s recover_signer first');
  check((await page.locator('#near-bounty-1 .claimbox .ships a', { hasText: 'evidence' }).count()) === 3, 'with the three evidence links');
  await page.screenshot({ path: path.join(SHOTS, 'near-claim-desktop-light.png'), fullPage: false });
  await page.click('#near-bounty-1 [data-nact="confirm-claim"]');
  check(await until(() => near.txs.some((t) => t.method === 'claim')), 'Submit sends claim');
  const claim = near.txs.find((t) => t.method === 'claim');
  check(claim.args.id === 1 && /^0x[0-9a-f]{130}$/i.test(claim.args.signature) && claim.args.attestation.ships === 3 && claim.deposit === 1250000000000000000000n && claim.gas === 150n * 10n ** 12n, 'claim(1, attestation, 65-byte signature) with 0.00125 NEAR and 150 TGas');
  check(await until(async () => /Paid out/.test(await text(page, '#near-bounty-1'))), 'bounty #1 reads Paid out');
  check(bal(TIES['predict-fwa'].toLowerCase()) === 100_000_000n, 'the builder’s eth-implicit account holds the 100 USDC');
  const paidPost = await xPost(page, '#near-bounty-1 [data-nx]');
  check(paidPost === 'predict FWA shipped 3 times and was paid 100 USDC on NEAR, released when @HeyResearch counted the ships on chain. #NEARHackathon https://hey-research-lab.github.io/proof-of-ship/?chain=near#near-bounty-1' && paidPost.length <= 280, 'the paid bounty’s post says what was paid, under 280 characters');
  check((await text(page, '#near-bounty-1 [data-ncount] .v')) === 'Paid out', 'and its countdown reads Paid out');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ================================================================== NEAR: the countdown ticks, a long name still fits a post
{
  console.log('\n# NEAR, countdown and a long project name');
  const t = NOW();
  const id = near.bounties.length;
  near.bounties.push({ id, slug: 'long-name', builder: TIES['long-name'].toLowerCase(), creator: ALICE, start: t - DAY, deadline: t + 3 * DAY + 7200, min_ships: 12, payout: 'near', status: 'open', total: 1_234_567_890_123n, paid_out: 0n, funders: 1, ships: 0, evidence: null, failed_payouts: 0 });
  near.contrib.set(`${id}:${ALICE}`, 1_234_567_890_123n);
  const { page, ctx, errors } = await newPage({ width: 400, height: 860 });
  await page.clock.install();
  await page.goto(`${BASE}/?chain=near#near-bounty-${id}`);
  const sel = `#near-bounty-${id}`;
  check(await until(async () => (await page.locator(`${sel} [data-nx]`).count()) === 1 && !(await page.getAttribute(sel, 'data-pending'))), 'the long-named bounty offers Post on X');
  const post = await xPost(page, `${sel} [data-nx]`);
  check(post.length <= 280 && post.endsWith(`#NEARHackathon https://hey-research-lab.github.io/proof-of-ship/?chain=near#near-bounty-${id}`) && /I'm backing The Extraordinarily .*… on NEAR: 1,234,567\.89 USDC if they ship 12 times by /.test(post), `a long name is cut so the post stays at ${post.length} characters, link kept`);
  const before = await text(page, `${sel} [data-ncount] .v`);
  const box = await page.locator(sel).boundingBox();
  await page.clock.fastForward('01:00');
  check(await until(async () => minutesOf(await text(page, `${sel} [data-ncount] .v`)) === minutesOf(before) - 1), `the countdown moves on the minute: ${before} then ${await text(page, `${sel} [data-ncount] .v`)}`);
  const after = await page.locator(sel).boundingBox();
  check(Math.abs(after.height - box.height) < 0.5 && Math.abs(after.width - box.width) < 0.5, 'and the card does not move or resize');
  await page.locator(sel).screenshot({ path: path.join(SHOTS, 'near-card-mobile-light.png') });
  check(await noSideScroll(page), 'no sideways scroll at 400 px');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
// The confirmation at 400 px, light and dark.
for (const scheme of ['light', 'dark']) {
  const { page, ctx, errors } = await newPage({ width: 400, height: 860, scheme });
  await page.goto(`${BASE}/?chain=near`);
  await page.click('#nConnect');
  await page.click('#nearWalletList [data-wallet="test"]');
  await until(async () => (await text(page, '#nAccount')).includes('funder.near'));
  await pick(page, '#nSlug', 'predict');
  await until(async () => /HEY ties this address/.test(await text(page, '#nBuilderHint')));
  await until(async () => (await page.getAttribute('#nPace [data-pace]', 'data-pace').catch(() => null)) === 'likely');
  await page.locator('#nMinShips').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, `near-pace-mobile-${scheme}.png`), fullPage: false });
  await page.click('#nOpenBtn');
  check(await until(() => page.evaluate(() => document.querySelector('#nConfirm').open)), `the confirmation opens at 400 px (${scheme})`);
  const fits = await page.evaluate(() => { const r = document.querySelector('#nConfirm').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
  check(fits && await noSideScroll(page), `and fits the screen (${scheme})`);
  await page.screenshot({ path: path.join(SHOTS, `near-confirm-mobile-${scheme}.png`), fullPage: false });
  await page.click('#nConfirmNo');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}


// ================================================================== one page, both chains
const contrastOf = (page, sels) => page.evaluate((list) => {
  const rgba = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ground = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } }
    let bg = [255, 255, 255, 1];
    if (!stack.length || stack[stack.length - 1][3] < 1) bg = rgba(getComputedStyle(document.body).backgroundColor) ?? bg;
    for (const c of stack.reverse()) bg = over(c, bg);
    return bg;
  };
  return list.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, ratio: null };
    const bg = ground(el);
    const fg = over(rgba(getComputedStyle(el).color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return { sel, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
  });
}, sels);
const TEXT_SELECTORS = ['h1', '.lede', '.eyebrow', '.sh p', '.figs tbody th', '.figs td small', '.figs thead th', '#figures .cb-robinhood', '#figures .cb-near', '.flow .live', '.flow .nk', '.escrows dt', '#allBounties .chip', '#allBounties .slug', '#allBounties .fact .k', '.feed .at', '.feed .what', '#filter button[aria-pressed="false"]', 'footer', '.hint'];
seedNear();
{
  console.log('\n# Both chains: figures, the one list, the diagram, the feed');
  hey.nearLive = true;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/`);
  check(await until(async () => (await text(page, '#tCount')) === '4'), 'Both chains: 4 bounties (2 on Robinhood Chain, 2 on NEAR), read from the two contracts');
  check((await text(page, '#sCount')) === '2' && (await text(page, '#nsCount')) === '2', 'each chain’s own count: 2 and 2');
  check(await until(async () => (await text(page, '#tOpen')) === '2'), 'open now: 1 + 1 = 2');
  const locked = await text(page, '#tLocked');
  check(/5,000\s*WIF/.test(locked) && /150\s*USDC/.test(locked) && !/5,150|\$/.test(locked), `locked now, side by side and never added: “${locked.replace(/\s+/g, ' ')}”`);
  const paid = await text(page, '#tPaid');
  check(/4,900\s*WIF/.test(paid) && /0\s*USDC/.test(paid), `paid to builders, in each token: “${paid.replace(/\s+/g, ' ')}”`);
  check((await text(page, '#sBuilders')) === '1' && (await text(page, '#nsBuilders')) === '0' && (await text(page, '#tBuilders')) === '1', 'builders paid: 1 on Robinhood Chain, 0 on NEAR, 1 in all');
  check(/100\s*WIF/.test(await text(page, '#tBurned')), 'burned on payout: 100 WIF, Robinhood Chain only');
  check(await until(async () => /2 bounties · 5,000 WIF locked now/.test(await text(page, '#fRhLive')) && /2 bounties · 150 USDC locked now/.test(await text(page, '#fNearLive'))), 'the diagram carries each escrow’s live figures');
  check(await until(async () => /✓ ShipEscrow’s attester\(\) and ✓ the NEAR escrow’s get_config/.test(await text(page, '#fAttesterLive'))), 'the diagram: both escrows name the same attester, read from each contract');
  check(/✓/.test(await text(page, '#fRhSep')) && /✓/.test(await text(page, '#fNearSep')) && (await page.getAttribute('#fRhSep [title]', 'title')) !== (await page.getAttribute('#fNearSep [title]', 'title')), 'two different domain separators, each the one its escrow computes');

  // The one list: both chains, a badge on every card, ordered by date.
  check(await until(async () => (await page.locator('#allBounties > article.bounty').count()) === 4), 'one list holds all 4 funded bounties of both chains');
  const order = await page.locator('#allBounties > article.bounty').evaluateAll((as) => as.map((a) => ({ id: a.id, start: Number(a.dataset.start), deadline: Number(a.dataset.deadline) })));
  check(order.every((x, i) => i === 0 || order[i - 1].start >= x.start), `newest first by the day it opened: ${order.map((x) => x.id).join(', ')}`);
  check((await page.locator('#allBounties > article.bounty .cb-robinhood').count()) === 2 && (await page.locator('#allBounties > article.bounty .cb-near').count()) === 2, 'every card carries its chain badge');
  check(await until(async () => /^Time left to ship$/.test(await text(page, '#bounty-1 [data-rcount] .k')) && /^\d+d \d\dh \d\dm$/.test(await text(page, '#bounty-1 [data-rcount] .v'))), `a Robinhood Chain card counts down too: ${await text(page, '#bounty-1 [data-rcount] .v')}`);
  check((await text(page, '#bounty-0 [data-rcount] .v')) === 'Paid out', 'and a paid one reads Paid out');
  await reveal(page, '#near-bounty-1');
  check(await until(async () => (await page.locator('#near-bounty-1 .ships a', { hasText: 'evidence' }).count()) === 3), 'counted ships with their evidence links on a NEAR card');
  await reveal(page, '#bounty-1');
  check(await until(async () => (await page.locator('#bounty-1 .ships a', { hasText: 'source' }).count()) === 1), 'and with their source links on a Robinhood Chain card');
  const amountsShown = await page.locator('#allBounties > article.bounty').evaluateAll((as) => as.map((a) => a.dataset.on));
  await page.click('#filter [data-show="near"]');
  check(await until(async () => (await page.locator('#allBounties > article.bounty:visible').count()) === 2 && (await page.locator('#allBounties > article.bounty[data-on="robinhood"]:visible').count()) === 0), 'the NEAR filter shows only NEAR bounties');
  check((await page.getAttribute('#filter [data-show="near"]', 'aria-pressed')) === 'true' && (await text(page, '#filter [data-show="near"] .ct')) === '2', 'and says NEAR 2');
  await page.click('#filter [data-show="robinhood"]');
  check(await until(async () => (await page.locator('#allBounties > article.bounty:visible').count()) === 2 && (await page.locator('#allBounties > article.bounty[data-on="near"]:visible').count()) === 0), 'the Robinhood Chain filter shows only Robinhood Chain bounties');
  await page.click('#filter [data-show="all"]');
  check((await page.locator('#allBounties > article.bounty:visible').count()) === 4, 'All shows all four again');
  await page.click('#order [data-order="deadline"]');
  const byDeadline = await page.locator('#allBounties > article.bounty').evaluateAll((as) => as.map((a) => a.id));
  check(byDeadline[0] === 'near-bounty-1' && byDeadline[1] === 'bounty-1', `Ending soonest puts the open bounty with the nearest deadline first: ${byDeadline.join(', ')}`);
  await page.click('#order [data-order="newest"]');
  check(amountsShown.length === 4, 'the order never reads an amount (by date only)');

  // The feed: both chains, newest first, each event linked to its transaction.
  check(await until(async () => (await page.locator('#feedList li[data-kind]').count()) === 9), `the feed: 5 Robinhood Chain events and 4 NEAR events (${(await page.locator('#feedList li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' | ')})`);
  const feedRows = await page.locator('#feedList li[data-kind]').evaluateAll((ls) => ls.map((l) => ({ kind: l.dataset.kind, on: l.dataset.on, at: Date.parse(l.querySelector('time')?.getAttribute('datetime') ?? ''), href: l.querySelector('.at a')?.href ?? '', text: l.innerText })));
  check(feedRows.every((r, i) => i === 0 || feedRows[i - 1].at >= r.at), 'newest first');
  check(feedRows.filter((r) => r.on === 'robinhood').every((r) => /^https:\/\/robinhoodchain\.blockscout\.com\/tx\/0x[0-9a-f]{64}$/.test(r.href)), 'every Robinhood Chain event links its transaction on Blockscout');
  check(feedRows.filter((r) => r.on === 'near').every((r) => /^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(r.href)), 'every NEAR event links its transaction on nearblocks');
  check(feedRows.some((r) => r.kind === 'released' && /4,900 WIF to the builder, 100 burned · 3 ships counted/.test(r.text)), 'a release says what the builder got and what was burned');
  check(['opened', 'funded', 'released'].every((k) => feedRows.some((r) => r.kind === k && r.on === 'robinhood')) && ['opened', 'funded'].every((k) => feedRows.some((r) => r.kind === k && r.on === 'near')), 'opened, funded and released events from both chains');
  check(rh.logReads.length > 0 && rh.logReads.every((f) => Number(f.fromBlock) >= RH_FROM && f.address?.toLowerCase() === RH_ESCROW.toLowerCase()), 'Robinhood Chain events come from eth_getLogs on the escrow, from its deploy block');

  // The HEY logo, header and footer.
  check((await page.getAttribute('header a.hey', 'href')) === 'https://heyresearch.xyz' && (await page.getAttribute('header a.hey svg', 'aria-label')) === 'HEY Research Lab' && await page.isVisible('header a.hey svg'), 'the HEY mark in the header, labelled HEY Research Lab, links to heyresearch.xyz');
  check((await page.getAttribute('footer a.hey', 'href')) === 'https://heyresearch.xyz' && (await page.getAttribute('footer a.hey svg', 'aria-label')) === 'HEY Research Lab', 'and in the footer');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, 'overview-desktop-light.png'), fullPage: false });
  await page.locator('#bounties-section').screenshot({ path: path.join(SHOTS, 'list-desktop-light.png') });
  await page.locator('#feed').screenshot({ path: path.join(SHOTS, 'feed-desktop-light.png') });
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
{
  console.log('\n# FastNear refuses once: the feed asks again');
  near.txApiFailures = 1;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/`);
  check(await until(async () => (await page.locator('#feedList li[data-on="near"] .at a[href*="/txns/"]').count()) === 4), 'after one refusal, the NEAR events come back with their transaction hashes');
  check(near.txApiFailures === 0 && (await text(page, '#feedNote')) === '', 'and no note about NEAR');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
{
  console.log('\n# NEAR transactions not readable: the feed says so and links the escrow');
  near.txApi = false;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/`);
  check(await until(async () => /NEAR transaction hashes could not be read just now/.test(await text(page, '#feedNote'))), 'the feed says NEAR’s transaction hashes could not be read');
  const nearRows = await page.locator('#feedList li[data-on="near"]').evaluateAll((ls) => ls.map((l) => ({ kind: l.dataset.kind, href: l.querySelector('.at a')?.href })));
  check(nearRows.length === 2 && nearRows.every((r) => r.kind === 'opened' && r.href === 'https://nearblocks.io/address/escrow.heyresearch.near'), 'NEAR bounties show when they opened, each linked to the escrow’s page, no hash made up');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  near.txApi = true;
  await ctx.close();
}
{
  console.log('\n# Verify a receipt');
  hey.nearLive = true;
  const txsBefore = near.txs.length, sentBefore = rh.sent.length;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/#verify`);
  await page.click('#rcptExample');
  check(await until(async () => (await page.getAttribute('#rcptOut', 'data-ok')) === 'true'), 'Try an example: a live HEY attestation for predict FWA checks out');
  check(/^Signed by HEY for ShipEscrow on Robinhood Chain \(WIF\)$/.test(await text(page, '#rcptHead')), `it says: “${await text(page, '#rcptHead')}”`);
  const att = JSON.parse(await page.inputValue('#rcpt'));
  const digest = hashTypedData({ domain: rhDomain, types: SHIPS_TYPES, primaryType: 'Ships', message: { ...att.attestation, since: BigInt(att.attestation.since), until: BigInt(att.attestation.until), issuedAt: BigInt(att.attestation.issuedAt) } });
  const out = await text(page, '#rcptOut');
  check(out.includes(digest), 'the page shows the EIP-712 digest it rebuilt, the same as the escrow’s domain gives');
  check(/Signed by HEY’s attester/.test(out) && out.includes(attester.address), 'it recovers HEY’s attester');
  check(/chain 4663 with verifyingContract ShipEscrow/.test(out) && out.includes(RH_ESCROW), 'it says the domain binds ShipEscrow on Robinhood Chain');
  check(/ShipEscrow’s own digest\(\) on Robinhood Chain returns the same digest/.test(out), 'and ShipEscrow’s own digest() agrees');
  const lastAtt = hey.attestations.at(-1);
  check(lastAtt.slug === 'predict-fwa' && lastAtt.escrow === RH_ESCROW && lastAtt.builder === TIES['predict-fwa'] && Number(lastAtt.until) < NOW(), 'the example asked HEY’s attestation route for predict FWA and the Robinhood Chain escrow, a closed window');
  await page.locator('#verify').screenshot({ path: path.join(SHOTS, 'verify-desktop-light.png') });

  // A wrong signer: the same attestation signed by another key.
  const other = privateKeyToAccount(keccak256(stringToBytes('someone else')));
  const message = { ...att.attestation, since: BigInt(att.attestation.since), until: BigInt(att.attestation.until), issuedAt: BigInt(att.attestation.issuedAt) };
  const forged = { ...att, signature: await other.signTypedData({ domain: rhDomain, types: SHIPS_TYPES, primaryType: 'Ships', message }), digest: undefined };
  await page.fill('#rcpt', JSON.stringify(forged));
  await page.click('#rcptVerify');
  check(await until(async () => (await page.getAttribute('#rcptOut', 'data-ok')) === 'false' && /Not signed by HEY’s attester/.test(await text(page, '#rcptHead'))), 'a wrong signer: “Not signed by HEY’s attester”');
  check((await text(page, '#rcptOut')).includes(other.address), 'and it names the key that did sign');

  // The same signature under NEAR's domain: a different digest, so it recovers someone else.
  const moved = { ...att, domain: nearDomain, typedData: undefined, digest: undefined };
  await page.fill('#rcpt', JSON.stringify(moved));
  await page.click('#rcptVerify');
  check(await until(async () => (await page.getAttribute('#rcptOut', 'data-ok')) === 'false' && /Not signed by HEY’s attester/.test(await text(page, '#rcptHead'))), 'a Robinhood Chain signature moved under NEAR’s domain does not verify: one attestation, one escrow');

  // A NEAR one: the domain binds escrow.heyresearch.near, and the escrow's own recover_signer agrees.
  const viewsBefore = near.views.length;
  await page.click('#rcptExampleNear');
  check(await until(async () => (await page.getAttribute('#rcptOut', 'data-ok')) === 'true' && (await page.getAttribute('#rcptOut', 'data-where')) === 'near'), 'Try a NEAR one: HEY’s NEAR attestation for Loom checks out');
  const nearOut = await text(page, '#rcptOut');
  check(/^Signed by HEY for escrow\.heyresearch\.near on NEAR \(USDC\)$/.test(await text(page, '#rcptHead')), `it says: “${await text(page, '#rcptHead')}”`);
  check(/chain 397 \(NEAR mainnet\) with salt keccak256\("escrow\.heyresearch\.near"\)/.test(nearOut), 'it says the domain is chain 397 with the escrow’s salt');
  check(/escrow\.heyresearch\.near’s own recover_signer recovers the same key and digest: is_attester: true/.test(nearOut) && near.views.slice(viewsBefore).includes('recover_signer'), 'and cross-checks with the escrow’s own recover_signer over RPC');
  check(hey.attestations.at(-1).escrow === `near:${NEAR_ESCROW}` && hey.attestations.at(-1).slug === 'loom', 'the NEAR example asked for escrow=near:escrow.heyresearch.near');
  await page.fill('#rcpt', '{"hello":1}');
  await page.click('#rcptVerify');
  check(await until(async () => /Not a HEY attestation/.test(await text(page, '#rcptHead'))), 'anything else: “Not a HEY attestation”');
  check(near.txs.length === txsBefore && rh.sent.length === sentBefore, 'verifying sends nothing, on either chain');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
{
  console.log('\n# Project view');
  hey.nearLive = true;
  const txsBefore = near.txs.length, sentBefore = rh.sent.length;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/?project=predict-fwa`);
  check(await until(async () => (await text(page, '#pvName')) === 'predict FWA'), 'the project view opens for predict FWA');
  check(await page.isHidden('#hero') && await page.isHidden('#figures'), 'the project leads; the overview steps aside');
  check(await until(async () => (await page.locator('#allBounties > article.bounty:visible').count()) === 2), 'every bounty for predict FWA on both chains: 2');
  const shownIds = await page.locator('#allBounties > article.bounty:visible').evaluateAll((as) => as.map((a) => a.id).sort());
  check(shownIds.join() === 'bounty-0,near-bounty-1', `Robinhood Chain #0 and NEAR #1, nothing of fly.ai: ${shownIds.join(', ')}`);
  check(await until(async () => (await page.getAttribute('#pvShips [data-ships]', 'data-ships')) === '10'), 'HEY’s counted ships, last 30 days: 10');
  check((await page.locator('#pvShips .ships a', { hasText: 'evidence' }).count()) === 8 && /and 2 more/.test(await text(page, '#pvShips')), 'eight with their evidence links, and 2 more');
  const sc = hey.shipsCalls.at(-1);
  check(sc.slug === 'predict-fwa' && Number(sc.until) - Number(sc.since) === 30 * DAY && Number(sc.until) % 3600 === 0, 'read from the ships route over the last 30 closed days');
  check((await page.inputValue('#pvLink')) === 'https://hey-research-lab.github.io/proof-of-ship/?project=predict-fwa', 'a copyable link to the project view');
  const embed = await page.inputValue('#pvEmbed');
  check(embed === '<a href="https://hey-research-lab.github.io/proof-of-ship/?project=predict-fwa"><img src="https://hey-research-lab.github.io/proof-of-ship/badge.svg" alt="Back predict FWA on Proof of Ship" width="236" height="32"></a>' && !/iframe|script/i.test(embed), 'an embed snippet: one <a> badge link, no iframe and no script');
  await page.screenshot({ path: path.join(SHOTS, 'project-desktop-light.png'), fullPage: false });
  await page.click('[data-back="near"]');
  check(await until(async () => await page.isVisible('#nearView') && (await page.inputValue('#nSlug')) === 'predict-fwa'), 'Back on NEAR opens the NEAR form with the project filled in');
  check(await until(async () => (await page.inputValue('#nBuilder')) === TIES['predict-fwa'] && /HEY ties this address/.test(await text(page, '#nBuilderHint'))), 'and the payout address HEY ties to it, checked');
  await page.click('[data-back="robinhood"]');
  check(await until(async () => await page.isVisible('#open') && (await page.inputValue('#slug')) === 'predict-fwa' && (await page.inputValue('#builder')) === TIES['predict-fwa']), 'Back on Robinhood Chain fills the Robinhood Chain form the same way');
  check(near.txs.length === txsBefore && rh.sent.length === sentBefore, 'nothing is signed or sent by the project view');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
{
  console.log('\n# Theme: System, Light, Dark');
  const { page, ctx, errors } = await newPage({ scheme: 'dark' });
  await page.goto(`${BASE}/`);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check((await page.getAttribute('#theme', 'data-mode')) === 'system' && (await bg()) === 'rgb(11, 14, 17)', 'by default the page follows the system (dark here)');
  check(/Theme: follows your system/.test(await page.getAttribute('#theme', 'aria-label')), 'the toggle has an accessible label');
  await page.click('#theme');
  check((await page.getAttribute('html', 'data-theme')) === 'light' && (await bg()) === 'rgb(245, 246, 248)', 'one press: Light, whatever the system says');
  check((await page.evaluate(() => localStorage.getItem('pos.theme'))) === 'light', 'remembered in this browser');
  await page.reload();
  check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light' && (await bg()) === 'rgb(245, 246, 248)', 'after a reload, still Light');
  const firstPaint = await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /theme\.js/.test(r.name)));
  check(firstPaint && (await page.evaluate(() => [...document.head.querySelectorAll('script')].findIndex((s) => /theme\.js/.test(s.src)) >= 0 && !document.querySelector('script[src*="theme.js"]').type)), 'the theme is set by a classic script in <head>, before the page paints');
  await page.click('#theme');
  check((await page.getAttribute('html', 'data-theme')) === 'dark' && (await bg()) === 'rgb(11, 14, 17)', 'two presses: Dark');
  await page.click('#theme');
  check((await page.getAttribute('html', 'data-theme')) === null && (await page.evaluate(() => localStorage.getItem('pos.theme'))) === null, 'three: back to System, the choice forgotten');
  await page.focus('#theme');
  await page.keyboard.press('Enter');
  check((await page.getAttribute('html', 'data-theme')) === 'light', 'the toggle works from the keyboard');
  const ring = await page.evaluate(() => getComputedStyle(document.querySelector('#theme')).outlineStyle);
  check(ring !== 'none', `with a visible focus ring (${ring})`);
  await page.evaluate(() => localStorage.removeItem('pos.theme'));
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}
for (const theme of ['light', 'dark']) {
  console.log(`\n# Contrast and layout, ${theme}`);
  for (const [w, h] of [[1280, 900], [400, 860]]) {
    const { page, ctx, errors } = await newPage({ width: w, height: h, scheme: theme === 'dark' ? 'light' : 'dark' });
    await page.addInitScript((t) => { try { localStorage.setItem('pos.theme', t); } catch { /* */ } }, theme);
    await page.goto(`${BASE}/`);
    await until(async () => (await page.locator('#feedList li[data-kind]').count()) > 0 && (await text(page, '#tCount')) !== '…');
    await reveal(page, '#bounty-1');
    await until(async () => !(await page.getAttribute('#bounty-1', 'data-pending')));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const name = `overview-${w === 400 ? 'mobile' : 'desktop'}-${theme}`;
    if (w === 1280) {
      const ratios = await contrastOf(page, TEXT_SELECTORS);
      const low = ratios.filter((r) => r.ratio !== null && r.ratio < 4.5);
      check(low.length === 0 && ratios.filter((r) => r.ratio !== null).length >= 16, `every text token reads at 4.5:1 or more (${theme}; lowest ${Math.min(...ratios.filter((r) => r.ratio).map((r) => r.ratio))}${low.length ? `; low: ${low.map((r) => `${r.sel} ${r.ratio}`).join(', ')}` : ''})`);
      const mark = await page.evaluate(() => { const l = getComputedStyle(document.querySelector('header .mark .l')).fill; const i = getComputedStyle(document.querySelector('header .mark .i')).fill; return { l, i }; });
      check(theme === 'dark' ? mark.i === 'rgb(233, 236, 240)' && mark.l === 'rgb(194, 251, 3)' : mark.i === 'rgb(11, 14, 17)' && mark.l === 'rgb(79, 122, 0)', `the HEY mark in ${theme}: ink ${mark.i}, lime ${mark.l}`);
    }
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: w === 400 });
    if (w === 400) {
      await page.locator('#flow').screenshot({ path: path.join(SHOTS, `diagram-mobile-${theme}.png`) });
      await page.locator('#figures').screenshot({ path: path.join(SHOTS, `figures-mobile-${theme}.png`) });
      await page.locator('#bounty-1').screenshot({ path: path.join(SHOTS, `card-rh-mobile-${theme}.png`) });
      for (const [sel, part] of [['#bounties-section', 'list'], ['#open-section', 'open'], ['#feed', 'feed'], ['#trust', 'trust'], ['footer', 'footer']]) {
        await reveal(page, sel);
        await page.locator(sel).screenshot({ path: path.join(SHOTS, `${part}-mobile-${theme}.png`) });
      }
    }
    check(await noSideScroll(page), `${name}: no sideways scroll`);
    check(errors.length === 0, `${name}: no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }
}
for (const theme of ['light', 'dark']) {
  const { page, ctx, errors } = await newPage({ width: 400, height: 860, scheme: theme });
  await page.goto(`${BASE}/?project=loom`);
  await until(async () => (await page.getAttribute('#pvShips [data-ships]', 'data-ships').catch(() => null)) !== null);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `project-mobile-${theme}.png`), fullPage: false });
  check(await noSideScroll(page), `project-mobile-${theme}: no sideways scroll`);
  await page.goto(`${BASE}/#verify`);
  await page.click('#rcptExampleNear');
  await until(async () => (await page.getAttribute('#rcptOut', 'data-ok')) === 'true');
  await page.locator('#verify').screenshot({ path: path.join(SHOTS, `verify-mobile-${theme}.png`) });
  check(await noSideScroll(page), `verify-mobile-${theme}: no sideways scroll`);
  check(errors.length === 0, `project and verify at 400 px, ${theme}: no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ================================================================== screenshots: 400 px, light and dark
for (const [w, h, scheme] of [[1280, 900, 'dark'], [400, 860, 'light'], [400, 860, 'dark']]) {
  for (const chain of ['near', 'robinhood']) {
    const { page, ctx, errors } = await newPage({ width: w, height: h, scheme });
    await page.goto(`${BASE}/${chain === 'near' ? '?chain=near' : ''}`);
    await until(async () => (await text(page, chain === 'near' ? '#nsCount' : '#sOpen')) !== '…');
    await page.waitForTimeout(600);
    const name = `${chain}-${w === 400 ? 'mobile' : 'desktop'}-${scheme}`;
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: w === 400 });
    check(await noSideScroll(page), `${name}: no sideways scroll`);
    check(errors.length === 0, `${name}: no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }
}

check(live.length === 0, `no check reached a live host (${[...new Set(live)].slice(0, 5).join(' | ')})`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
