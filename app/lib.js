/*
 * What the two chain modules (app.js for Robinhood Chain, near.js for NEAR) and the overview (hub.js) share: the one
 * bounty list both chains draw their cards into, its filter and date order, the chain badge, the countdown words and
 * the figures each chain reports. Nothing here reads a chain, signs or sends.
 */

export const CHAINS = {
  robinhood: { name: 'Robinhood Chain', token: 'WIF' },
  near: { name: 'NEAR', token: 'USDC' },
};
/** The badge every card, feed row and figure carries: which chain, in which token. */
export const badge = (chain) => `<span class="cb cb-${chain}"><i aria-hidden="true"></i>${CHAINS[chain].name}<small>${CHAINS[chain].token}</small></span>`;

const pad2 = (n) => String(n).padStart(2, '0');
/** "3d 04h 12m", "4h 05m", "12m": a span of seconds, always the same shape for the same number of units. */
export function span(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${pad2(h)}h ${pad2(m)}m` : h ? `${h}h ${pad2(m)}m` : `${m}m`;
}

// ------------------------------------------------------------------ the one bounty list
/*
 * Both chains place their cards into #allBounties. The order is by date only: newest opened first, or the open
 * bounties whose deadline comes soonest first (then the closed ones, latest deadline first). Never by amount.
 */
const box = () => document.getElementById('allBounties');
let order = 'newest';
const n = (card, k) => Number(card.dataset[k] ?? 0);
function before(a, b) {
  if (order === 'deadline') {
    const t = Date.now() / 1000;
    const ao = n(a, 'deadline') >= t, bo = n(b, 'deadline') >= t;
    if (ao !== bo) return ao;
    if (n(a, 'deadline') !== n(b, 'deadline')) return ao ? n(a, 'deadline') < n(b, 'deadline') : n(a, 'deadline') > n(b, 'deadline');
  } else if (n(a, 'start') !== n(b, 'start')) return n(a, 'start') > n(b, 'start');
  // Same date: a stable, amount-free tie break.
  return `${a.dataset.on}:${a.id}` < `${b.dataset.on}:${b.id}`;
}
const cards = () => [...(box()?.querySelectorAll(':scope > article.bounty') ?? [])];
/** Put a chain's card where its date puts it among both chains' cards. */
export function placeCard(card) {
  const list = box();
  if (!list) return;
  list.querySelector(':scope > [data-skel]')?.remove();
  const next = cards().find((c) => c !== card && before(card, c));
  if (next) list.insertBefore(card, next); else list.append(card);
}
/** Take one chain's cards off the list before it draws them again. */
export function removeCards(chain) {
  box()?.querySelectorAll(`:scope > article.bounty[data-on="${chain}"]`).forEach((c) => c.remove());
}
export function setOrder(which) {
  order = which === 'deadline' ? 'deadline' : 'newest';
  const list = box();
  if (!list) return;
  const sorted = cards().sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  for (const c of sorted) list.append(c);
}

// What each chain said about its list: null while it reads, then { count, note } (count = funded cards it drew).
const ready = { robinhood: null, near: null };
/** A chain finished drawing its cards (or could not): the empty state and the filter counts follow. */
export function chainReady(chain, note = '') {
  ready[chain] = { note };
  box()?.querySelector(':scope > [data-skel]')?.remove();
  refresh();
}
let show = 'all', slug = null;
const FILTER_STYLE = 'posFilter';
/** Which chain's cards show (all, robinhood, near), and only one project's when the project view is open. */
export function setFilter({ chain = show, project = slug } = {}) {
  show = ['robinhood', 'near'].includes(chain) ? chain : 'all';
  slug = project && /^[a-z0-9][a-z0-9-]{0,127}$/.test(project) ? project : null;
  const list = box();
  if (list) list.dataset.show = show;
  // A card is redrawn whenever HEY answers for it, so the filter is a style rule, never an attribute on the card.
  let el = document.getElementById(FILTER_STYLE);
  if (!el) { el = document.createElement('style'); el.id = FILTER_STYLE; document.head.append(el); }
  el.textContent = slug ? `#allBounties>article.bounty:not([data-slug="${slug}"]){display:none}` : '';
  document.querySelectorAll('#filter [data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.show === show)));
  refresh();
}
const visible = (c) => (show === 'all' || c.dataset.on === show) && (!slug || c.dataset.slug === slug);
function refresh() {
  const list = box();
  const empty = document.getElementById('listEmpty');
  if (!list || !empty) return;
  const all = cards();
  for (const chain of ['robinhood', 'near']) {
    const el = document.querySelector(`#filter [data-show="${chain}"] .ct`);
    if (el) el.textContent = ready[chain] ? String(all.filter((c) => c.dataset.on === chain && (!slug || c.dataset.slug === slug)).length) : '';
  }
  const allCt = document.querySelector('#filter [data-show="all"] .ct');
  if (allCt) allCt.textContent = ready.robinhood && ready.near ? String(all.filter((c) => !slug || c.dataset.slug === slug).length) : '';
  const waiting = show === 'all' ? !ready.robinhood && !ready.near : !ready[show];
  const shown = all.filter(visible).length;
  if (shown || waiting) { empty.hidden = true; return; }
  const where = show === 'all' ? 'on either chain' : `on ${show === 'near' ? 'NEAR' : 'Robinhood Chain'}`;
  const notes = (show === 'all' ? ['robinhood', 'near'] : [show]).map((c) => ready[c]?.note).filter(Boolean);
  empty.textContent = `${slug ? 'No funded bounty for this project' : 'No funded bounties'} ${where} yet.${notes.length ? ` ${notes.join(' ')}` : ' Open the first one below.'}`;
  empty.hidden = false;
}
if (typeof MutationObserver !== 'undefined') {
  const start = () => { const list = box(); if (list) new MutationObserver(refresh).observe(list, { childList: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}

// ------------------------------------------------------------------ figures each chain reports
/** A chain's figures, read from its contract: hub.js adds the counts and sets the amounts side by side. */
const lastStats = { robinhood: null, near: null };
export const emitStats = (chain, stats) => {
  lastStats[chain] = { chain, ...stats };
  document.dispatchEvent(new CustomEvent('pos:stats', { detail: lastStats[chain] }));
};
/** The figures a chain reported before a listener was there. */
export const statsOf = (chain) => lastStats[chain];
