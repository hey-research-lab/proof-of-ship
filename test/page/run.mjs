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
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, recoverTypedDataAddress, stringToBytes } from 'viem';
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
};
const TIES = { 'predict-fwa': '0x420944b441715E34Dd672AE0Eb4526A7AD7d1EEF', 'fly-ai': '0x625862521777E19Ad54Ce6C7ABeD9Ca54D6589ea' };
const SHIPS = { 'predict-fwa': 3, 'fly-ai': 1 };
const NEAR_ESCROW = 'escrow.heyresearch.near';
const RH_ESCROW = '0x3Da17a89F1d29aB96419269514C798a8dd6125f2';
const hey = { nearLive: false, attestations: [] };
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
    return json(200, { attestation, signature, domain, escrow: p.escrow, escrowKind: isNear ? 'near' : 'evm', builderTie: 'wallet_claim', evidenceIds: ids, evidenceUrls: ids.map((id) => `https://heyresearch.xyz/e/${id}`), signer: attester.address });
  }
  return json(404, { error: 'not_found' });
}

// ------------------------------------------------------------------ mocked NEAR: the escrow's rules, the token, the RPC
const ME = 'funder.near', ALICE = 'alice.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const near = { bounties: [], contrib: new Map(), usdc: new Map(), txs: [], views: [] };
const bal = (a) => near.usdc.get(a) ?? 0n;
const addBal = (a, v) => near.usdc.set(a, bal(a) + v);
function seedNear() {
  near.bounties = []; near.contrib = new Map(); near.usdc = new Map([[ME, 500_000_000n]]); near.txs = []; near.views = [];
  const t = NOW();
  const mk = (slug, creator, start, deadline, minShips, funder, amount) => {
    const id = near.bounties.length;
    near.bounties.push({ id, slug, builder: TIES[slug].toLowerCase(), creator, start, deadline, min_ships: minShips, payout: 'near', status: 'open', total: amount, paid_out: 0n, funders: 1, ships: 0, evidence: null, failed_payouts: 0 });
    near.contrib.set(`${id}:${funder}`, amount);
    addBal(NEAR_ESCROW, amount);
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
    case 'get_config': return { attester: attester.address.toLowerCase(), token: USDC, chain_id: 397, salt: nearDomain.salt, domain_separator: '0x', guardian: 'heyresearch.near', intents: 'intents.near', token_storage_deposit: '1250000000000000000000', retired: false, max_attestation_age: 86400, claim_grace: GRACE, min_duration: DAY, max_duration: 365 * DAY };
    case 'bounty_count': return near.bounties.length;
    case 'get_bounties': { const from = args.from_index ?? 0; return near.bounties.slice(from, from + Math.min(args.limit ?? 50, 50)).map(viewOf); }
    case 'get_bounty': return near.bounties[args.id] ? viewOf(near.bounties[args.id]) : null;
    case 'get_contribution': return String(near.contrib.get(`${args.id}:${args.account_id}`) ?? 0n);
    case 'recover_signer': {
      const a = args.attestation;
      const signer = await recoverTypedDataAddress({ domain: nearDomain, types: SHIPS_TYPES, primaryType: 'Ships', message: { ...a, since: BigInt(a.since), until: BigInt(a.until), issuedAt: BigInt(a.issuedAt) }, signature: args.signature });
      return { signer: signer.toLowerCase(), is_attester: signer === attester.address, error: null, digest: '0x' };
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
    addBal(NEAR_ESCROW, -amount); addBal(signer, amount);
    return true;
  }
  panic(`no method ${tx.receiverId}.${a.methodName}`);
}
let txn = 0;
const fakeHash = () => `${'1'.repeat(40)}${String(++txn).padStart(4, '2')}`.replace(/0/g, '2');
async function nearSend(tx) {
  try {
    const value = await nearExec(tx);
    return { status: { SuccessValue: Buffer.from(JSON.stringify(value)).toString('base64') }, transaction: { hash: fakeHash() } };
  } catch (e) {
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

// ------------------------------------------------------------------ mocked Robinhood Chain
const ABI = JSON.parse(fs.readFileSync(path.join(APP, 'ShipEscrow.abi.json'), 'utf8'));
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const WIF = '0x5173b8eA6923c2d40267890D45C46a3480954773';
const RH_ME = '0x1111111111111111111111111111111111111111';
const rh = { sent: [] };
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
  const r = { bountyCount: 2n, retired: false, contributed: 0n }[functionName];
  if (r !== undefined) return encodeFunctionResult({ abi: ABI, functionName, result: r });
  if (functionName === 'bounty') { const { slug, ...b } = bs[Number(args[0])]; return encodeFunctionResult({ abi: ABI, functionName, result: b }); }
  if (functionName === 'slugOf') return encodeFunctionResult({ abi: ABI, functionName, result: bs[Number(args[0])].slug });
  throw new Error(`rh call ${functionName}`);
}
async function rhRpc(route) {
  const body = JSON.parse(route.request().postData() ?? '{}');
  const one = (q) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: q.id, result });
    if (q.method === 'eth_chainId') return ok('0x1237');
    if (q.method === 'eth_blockNumber') return ok('0x100');
    if (q.method === 'eth_getBlockByNumber') return ok({ number: '0x100', timestamp: `0x${NOW().toString(16)}`, hash: `0x${'ab'.repeat(32)}`, transactions: [] });
    if (q.method === 'eth_call') { try { return ok(rhCall(q.params[0].to, q.params[0].data)); } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } }
    return { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: `not mocked ${q.method}` } };
  };
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) });
}

// ------------------------------------------------------------------ the browser
const browser = await chromium.launch();
async function newPage({ width = 1280, height = 900, scheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
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
  await page.route('https://heyresearch.xyz/**', heyRoute);
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
  await page.screenshot({ path: path.join(SHOTS, 'near-not-signing-desktop-light.png'), fullPage: false });
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ================================================================== NEAR: the whole flow
{
  console.log('\n# NEAR, HEY signing');
  hey.nearLive = true;
  const { page, ctx, errors } = await newPage();
  await page.goto(`${BASE}/?chain=near`);
  check(await page.isVisible('#nearView'), '?chain=near opens on NEAR');
  check(await until(async () => /Target met/.test(await text(page, '#near-bounty-1'))), 'bounty #1: HEY counts 3 of 3, target met');
  check(await page.isHidden('#nSigning'), 'no “not signing” banner');
  check((await page.locator('#near-bounty-1 .ships a', { hasText: 'evidence' }).count()) === 3, 'three evidence links on the card');
  check(/Closed/.test(await text(page, '#near-bounty-0')), 'bounty #0: closed, funders can take back');

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
  await page.fill('#nAmount', '25');
  await page.click('#nPayoutSeg [data-payout="intents"]');
  check(/NEAR Intents/.test(await text(page, '#nRoute')), 'the preview reads NEAR Intents');
  await page.screenshot({ path: path.join(SHOTS, 'near-open-desktop-light.png'), fullPage: false });
  await page.click('#nOpenBtn');
  check(await until(() => near.txs.some((t) => t.method === 'create')), 'Open sends create');
  const create = near.txs.find((t) => t.method === 'create');
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
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

// ================================================================== screenshots: 400 px, light and dark
for (const [w, h, scheme] of [[1280, 900, 'dark'], [400, 860, 'light'], [400, 860, 'dark']]) {
  for (const chain of ['near', 'robinhood']) {
    const { page, ctx, errors } = await newPage({ width: w, height: h, scheme });
    await page.goto(`${BASE}/${chain === 'near' ? '?chain=near' : ''}`);
    await until(async () => (await text(page, chain === 'near' ? '#nsCount' : '#sOpen')) !== '—');
    await page.waitForTimeout(600);
    const name = `${chain}-${w === 400 ? 'mobile' : 'desktop'}-${scheme}`;
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: w === 400 });
    check(await noSideScroll(page), `${name}: no sideways scroll`);
    check(errors.length === 0, `${name}: no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
