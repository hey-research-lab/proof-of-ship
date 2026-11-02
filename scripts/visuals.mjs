// The README's pictures: the hero, the live stats card and the flow, each an SVG in a light and a dark version.
// The palette is Hey Research Lab's (the same THEMES as github.com/hey-research-lab's profile). Every picture is
// complete at rest: an animation only adds motion from a `from` keyframe, so GitHub's mobile app and thumbnails,
// which may not animate, still show every figure. Readers who ask for reduced motion get no motion at all.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";
export const THEMES = {
  dark: { bg: '#0B0E11', panel: '#14181D', line: '#272D35', ink: '#E9ECF0', sec: '#94A0AD', faint: '#3A424D', lime: '#C2FB03', limeSoft: 'rgba(194,251,3,0.16)', onLime: '#0B0E11' },
  light: { bg: '#F5F6F8', panel: '#FFFFFF', line: '#DDE1E7', ink: '#0B0E11', sec: '#535B66', faint: '#C5CBD3', lime: '#4F7A00', limeSoft: 'rgba(79,122,0,0.14)', onLime: '#FFFFFF' },
};
const REDUCED = '@media (prefers-reduced-motion: reduce){*{animation:none!important}}';
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Splits a sentence into lines of at most `max` characters, on spaces. */
function wrap(text, max) {
  const lines = [''];
  for (const word of text.split(' ')) {
    const next = `${lines.at(-1)} ${word}`.trim();
    if (next.length > max && lines.at(-1)) lines.push(word);
    else lines[lines.length - 1] = next;
  }
  return lines;
}

// ---------------------------------------------------------------- the hero

/** "Proof of Ship." with a bounty card whose three ships tick onto the counter, then the release. */
export function hero(theme) {
  const t = THEMES[theme];
  const w = 1200, h = 420;
  const cx = 756, cy = 58, cw = 396, ch = 304; // the bounty card
  const size = 54, gap = 12, sy = cy + 140; // the three ship slots
  const tick = 0.8, start = 0.5; // one ship every 0.8 s, after half a second
  const slots = [0, 1, 2].map((k) => {
    const x = cx + 26 + k * (size + gap);
    return `<rect x="${x + 0.75}" y="${sy + 0.75}" width="${size - 1.5}" height="${size - 1.5}" rx="10" fill="${t.bg}" stroke="${t.faint}" stroke-width="1.5" stroke-dasharray="4 4"/>
<g class="s" style="animation-delay:${(start + tick * (k + 1) - 0.3).toFixed(2)}s"><rect x="${x}" y="${sy}" width="${size}" height="${size}" rx="10" fill="${t.lime}"/><path d="M${x + 16} ${sy + 28} l8 8 l15 -18" fill="none" stroke="${t.onLime}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }).join('\n');
  // The counter: a column of digits behind a one-digit window. At rest the column sits on 3; the animation starts it
  // three digits lower (on 0) and steps it up one ship at a time.
  const dx = cx + 236, base = sy + 41, lh = 54;
  const digits = [0, 1, 2, 3].map((d) => `<text x="${dx}" y="${base - (3 - d) * lh}" font-family="${FONT}" font-size="40" font-weight="700" fill="${t.ink}">${d}</text>`).join('');
  const chips = ['No owner', 'HEY counts the ships', 'Refunds after the deadline'];
  let chipX = 56;
  const chipRow = chips.map((label) => {
    const cwid = Math.round(label.length * 8.4 + 40);
    const out = `<rect x="${chipX}" y="314" width="${cwid}" height="34" rx="17" fill="${t.panel}" stroke="${t.line}"/><circle cx="${chipX + 16}" cy="331" r="3.5" fill="${t.lime}"/><text x="${chipX + 27}" y="336" font-family="${MONO}" font-size="13" fill="${t.sec}">${esc(label)}</text>`;
    chipX += cwid + 10;
    return out;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Proof of Ship. Back a Robinhood Chain builder with $WIF. It pays out only when they ship.">
<defs>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="${t.faint}"/></pattern>
<linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0.38" stop-color="${t.bg}"/><stop offset="1" stop-color="${t.bg}" stop-opacity="0"/></linearGradient>
<clipPath id="win"><rect x="${dx - 4}" y="${sy}" width="34" height="${size}"/></clipPath>
</defs>
<style>.s{transform-box:fill-box;transform-origin:center;animation:pop .35s cubic-bezier(.2,.9,.3,1.3) both}@keyframes pop{from{opacity:0;transform:scale(.6)}}.roll{animation:roll ${(tick * 3).toFixed(1)}s steps(3,end) ${start}s both}@keyframes roll{from{transform:translateY(${3 * lh}px)}}.done{animation:in .5s ease-out ${(start + tick * 3 + 0.25).toFixed(2)}s both}@keyframes in{from{opacity:0;transform:translateY(6px)}}.up{animation:in .7s ease-out both}.p{animation:pulse 2.4s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}${REDUCED}</style>
<rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
<rect x="560" width="${w - 560}" height="${h}" rx="14" fill="url(#dots)" opacity=".7"/>
<rect x="560" width="420" height="${h}" fill="url(#fade)"/>
<g class="up">
<text x="56" y="78" font-family="${MONO}" font-size="13" letter-spacing="2" fill="${t.lime}">ROBINHOOD CHAIN · $WIF · HEY RESEARCH LAB</text>
<text x="52" y="168" font-family="${FONT}" font-size="76" font-weight="750" letter-spacing="-2.5" fill="${t.ink}">Proof of Ship<tspan fill="${t.lime}">.</tspan></text>
<text x="56" y="222" font-family="${FONT}" font-size="24" fill="${t.sec}">Back a Robinhood Chain builder with $WIF.</text>
<text x="56" y="258" font-family="${FONT}" font-size="24" font-weight="600" fill="${t.ink}">It pays out only when they ship.</text>
${chipRow}
</g>
<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="16" fill="${t.panel}" stroke="${t.line}"/>
<circle class="p" cx="${cx + 30}" cy="${cy + 37}" r="4" fill="${t.lime}"/>
<text x="${cx + 42}" y="${cy + 42}" font-family="${MONO}" font-size="12" letter-spacing="1.5" fill="${t.sec}">BOUNTY</text>
<text x="${cx + cw - 26}" y="${cy + 42}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${t.sec}">ShipEscrow</text>
<text x="${cx + 26}" y="${cy + 92}" font-family="${FONT}" font-size="44" font-weight="750" letter-spacing="-1" fill="${t.ink}">5,000 <tspan font-size="19" font-weight="500" fill="${t.sec}" letter-spacing="0">WIF</tspan></text>
<text x="${cx + 26}" y="${cy + 124}" font-family="${FONT}" font-size="14" fill="${t.sec}">Ships HEY counted</text>
${slots}
<g clip-path="url(#win)"><g class="roll">${digits}</g></g>
<text x="${dx + 34}" y="${base}" font-family="${FONT}" font-size="40" font-weight="400" fill="${t.sec}">/ 3</text>
<g class="done">
<rect x="${cx + 26}" y="${cy + 216}" width="${cw - 52}" height="38" rx="10" fill="${t.limeSoft}"/>
<path d="M${cx + 42} ${cy + 235} l5 5 l10 -11" fill="none" stroke="${t.lime}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
<text x="${cx + 66}" y="${cy + 240}" font-family="${FONT}" font-size="15" font-weight="650" fill="${t.lime}">Target met. Released to the builder.</text>
</g>
<text x="${cx + 26}" y="${cy + 282}" font-family="${FONT}" font-size="14" fill="${t.sec}">No ships by the deadline? Every backer takes it back.</text>
<text x="56" y="${h - 30}" font-family="${MONO}" font-size="12" fill="${t.sec}">hey-research-lab.github.io/proof-of-ship</text>
</svg>
`;
}

// ---------------------------------------------------------------- the stats card

/** Five live figures read from the escrow's events: locked now, paid, burned, bounties opened and paid out. */
export function statsCard(tiles, theme) {
  const t = THEMES[theme];
  const w = 1200, h = 214, gap = 14, top = 64, th = 112;
  const tw = (w - 48 - gap * (tiles.length - 1)) / tiles.length;
  const body = tiles.map(({ value, unit, label, accent }, i) => {
    const x = 24 + i * (tw + gap);
    const lines = wrap(label, 24);
    return `<g class="v" style="animation-delay:${(0.08 * i).toFixed(2)}s"><rect x="${x.toFixed(1)}" y="${top}" width="${tw.toFixed(1)}" height="${th}" rx="10" fill="${t.panel}" stroke="${t.line}"/>
<text x="${(x + 18).toFixed(1)}" y="${top + 48}" font-family="${FONT}" font-size="34" font-weight="700" letter-spacing="-1" fill="${accent ? t.lime : t.ink}">${esc(value)}${unit ? `<tspan font-size="15" font-weight="500" letter-spacing="0" fill="${t.sec}" dx="6">${esc(unit)}</tspan>` : ''}</text>
${lines.map((line, j) => `<text x="${(x + 18).toFixed(1)}" y="${top + 76 + j * 17}" font-family="${FONT}" font-size="13" fill="${t.sec}">${esc(line)}</text>`).join('\n')}</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(`Proof of Ship, live from Robinhood Chain: ${tiles.map((x) => `${x.value}${x.unit ? ` ${x.unit}` : ''} ${x.label}`).join('; ')}`)}">
<style>.v{animation:in .6s ease-out both}@keyframes in{from{opacity:0;transform:translateY(6px)}}${REDUCED}</style>
<rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
<text x="24" y="42" font-family="${MONO}" font-size="13" letter-spacing="2" fill="${t.lime}">LIVE FROM ROBINHOOD CHAIN</text>
<text x="${w - 24}" y="42" text-anchor="end" font-family="${FONT}" font-size="14" fill="${t.sec}">Read from the escrow's own events, every day</text>
${body}
<text x="24" y="${h - 14}" font-family="${MONO}" font-size="12" fill="${t.sec}">ShipEscrow 0x3Da17a89F1d29aB96419269514C798a8dd6125f2 · chain 4663</text>
</svg>
`;
}

// ---------------------------------------------------------------- the flow

/** Back, ship, HEY counts, release; or refund after the deadline. */
export function flow(theme) {
  const t = THEMES[theme];
  const w = 1200, h = 430, left = 40, top = 104, nh = 186, gap = 44;
  const nw = (w - 2 * left - 3 * gap) / 4;
  const steps = [
    { n: '01', title: 'Back', body: 'Anyone locks $WIF behind a project with a page on HEY. Anyone can add more.', code: 'create · fund' },
    { n: '02', title: 'Ship', body: 'The builder ships: releases, contract deployments, code. Each from a public source.', code: 'nothing to apply for' },
    { n: '03', title: 'HEY counts', body: 'HEY counts the ships by its public rule and signs the count, not a verdict.', code: 'EIP-712 signed count' },
    { n: '04', title: 'Release', body: 'At the target, anyone submits the count. The builder is paid, minus the burn share.', code: 'claim' },
  ];
  const nodes = steps.map((s, i) => {
    const x = left + i * (nw + gap);
    const last = i === steps.length - 1;
    const lines = wrap(s.body, 30);
    return `<g class="n" style="animation-delay:${(0.12 * i).toFixed(2)}s">
<rect x="${x.toFixed(1)}" y="${top}" width="${nw.toFixed(1)}" height="${nh}" rx="12" fill="${t.panel}" stroke="${last ? t.lime : t.line}" stroke-width="${last ? 1.5 : 1}"/>
<text x="${(x + 20).toFixed(1)}" y="${top + 34}" font-family="${MONO}" font-size="13" letter-spacing="1" fill="${t.lime}">${s.n}</text>
<text x="${(x + 20).toFixed(1)}" y="${top + 66}" font-family="${FONT}" font-size="22" font-weight="700" fill="${t.ink}">${esc(s.title)}</text>
${lines.map((line, j) => `<text x="${(x + 20).toFixed(1)}" y="${top + 94 + j * 20}" font-family="${FONT}" font-size="14.5" fill="${t.sec}">${esc(line)}</text>`).join('\n')}
<text x="${(x + 20).toFixed(1)}" y="${top + nh - 18}" font-family="${MONO}" font-size="12" fill="${t.sec}">${esc(s.code)}</text>
</g>`;
  }).join('\n');
  const my = top + nh / 2;
  const arrows = [0, 1, 2].map((i) => {
    const x1 = left + (i + 1) * nw + i * gap + 6, x2 = x1 + gap - 12;
    return `<path class="f" d="M${x1.toFixed(1)} ${my} H${(x2 - 6).toFixed(1)}" fill="none" stroke="${t.lime}" stroke-width="2" stroke-dasharray="5 5"/><path d="M${(x2 - 7).toFixed(1)} ${my - 5} L${x2.toFixed(1)} ${my} L${(x2 - 7).toFixed(1)} ${my + 5}" fill="none" stroke="${t.lime}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('\n');
  // The refund path: from under the count back to the backers.
  const ry = top + nh + 50;
  const fromX = left + 3 * (nw + gap) + nw / 2, toX = left + nw / 2;
  const label = 'Or refund: no target met by the deadline plus 3 days, and each backer takes back their own $WIF.';
  const lw = Math.round(label.length * 7.25 + 36);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="How Proof of Ship works: 1 Back, anyone locks $WIF behind a project. 2 Ship, the builder ships from public sources. 3 HEY counts the ships and signs the count with EIP-712. 4 Release to the builder at the target, or a refund to each backer after the deadline plus 3 days.">
<style>.n{animation:in .6s ease-out both}@keyframes in{from{opacity:0;transform:translateY(8px)}}.f{animation:flow 1.4s linear infinite}@keyframes flow{from{stroke-dashoffset:20}}${REDUCED}</style>
<rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
<text x="${left}" y="50" font-family="${MONO}" font-size="13" letter-spacing="2" fill="${t.lime}">HOW IT WORKS</text>
<text x="${left}" y="78" font-family="${FONT}" font-size="15" fill="${t.sec}">The escrow holds the $WIF. HEY only signs how many ships it counted. The contract does the rest.</text>
${nodes}
${arrows}
<path d="M${fromX.toFixed(1)} ${top + nh + 6} V${ry} H${(toX + 8).toFixed(1)} Q${toX.toFixed(1)} ${ry} ${toX.toFixed(1)} ${ry - 8} V${top + nh + 14}" fill="none" stroke="${t.sec}" stroke-width="1.6" stroke-dasharray="3 5"/>
<path d="M${(toX - 5).toFixed(1)} ${top + nh + 14} L${toX.toFixed(1)} ${top + nh + 7} L${(toX + 5).toFixed(1)} ${top + nh + 14}" fill="none" stroke="${t.sec}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="${((fromX + toX) / 2 - lw / 2).toFixed(1)}" y="${ry - 17}" width="${lw}" height="34" rx="17" fill="${t.bg}" stroke="${t.line}"/>
<text x="${((fromX + toX) / 2).toFixed(1)}" y="${ry + 5}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${t.sec}"><tspan font-weight="700" fill="${t.ink}">Or refund:</tspan> ${esc(label.replace('Or refund: ', ''))}</text>
<text x="${left}" y="${h - 22}" font-family="${MONO}" font-size="12" fill="${t.sec}">One contract, no owner. Source verified on Sourcify: ShipEscrow on Robinhood Chain (4663).</text>
</svg>
`;
}
