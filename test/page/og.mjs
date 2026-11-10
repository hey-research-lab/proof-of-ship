#!/usr/bin/env node
// Draws app/og.png (1200 x 630), the page's social image, from the page's own fonts and HEY's mark:
//   cd test/page && node og.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '../../app');
const font = (f) => `file://${path.join(APP, 'vendor/fonts', f)}`;
const MARK = '<path fill="#e9ecf0" d="M26 21C27 14 31 8.5 35.5 4.5C35 10.5 37.5 16.5 44 16.5L101 16.5C106.5 16.5 110.5 20.5 110.5 26L110.5 96C110.5 106 103 114 93 118.5L93.8 45L35 45C29.5 45 27.2 41.5 27 37Z"/><path fill="#c2fb03" d="M49 54.5C42 57.5 34.5 62 32.5 70.5L30 118C38.5 115 46 108 46.2 98C46.4 88 43 80.5 43.2 72C43.4 64 46 58.5 49 54.5Z"/>';
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:G;src:url('${font('Geist-Variable.woff2')}') format('woff2');font-weight:100 900}
@font-face{font-family:M;src:url('${font('GeistMono-Variable.woff2')}') format('woff2');font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#0b0e11;color:#e9ecf0;font-family:G,sans-serif;padding:64px 80px;position:relative;overflow:hidden}
.top{display:flex;align-items:center;gap:16px}
.top svg{height:44px;width:auto}
.top b{font-size:28px;font-weight:650;letter-spacing:-.01em}
.top span{font-family:M,monospace;font-size:18px;color:#94a0ad;margin-left:6px}
h1{margin-top:58px;font-size:96px;line-height:.98;letter-spacing:-.045em;font-weight:680}
h1 em{font-style:normal;color:#c2fb03;display:block}
.row{position:absolute;left:80px;right:80px;bottom:60px;display:flex;align-items:center;gap:14px}
.cb{display:inline-flex;align-items:center;gap:10px;font-size:22px;font-weight:600;padding:10px 16px;border-radius:999px}
.cb i{width:11px;height:11px;border-radius:3px}
.cb small{font-family:M,monospace;font-size:18px;font-weight:500;opacity:.85}
.rh{color:#8fb4ff;background:rgba(143,180,255,.12)}.rh i{background:#8fb4ff}
.nr{color:#c3a8ff;background:rgba(195,168,255,.12)}.nr i{background:#c3a8ff;border-radius:50%}
.row p{margin-left:auto;font-family:M,monospace;font-size:17px;color:#94a0ad;text-align:right;line-height:1.45}
.glow{position:absolute;right:-160px;top:-200px;width:620px;height:620px;border-radius:50%;background:radial-gradient(closest-side,rgba(194,251,3,.10),transparent)}
</style><div class="glow"></div>
<div class="top"><svg viewBox="24 2 90 120">${MARK}</svg><b>Proof of Ship</b><span>by HEY Research Lab</span></div>
<h1>Pay builders for shipping. <em>On any chain.</em></h1>
<div class="row"><span class="cb rh"><i></i>Robinhood Chain<small>WIF</small></span><span class="cb nr"><i></i>NEAR<small>USDC</small></span><p>One HEY signature per claim,<br>checked by the escrow on its chain.</p></div>`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-og-'));
const file = path.join(dir, 'og.html');
fs.writeFileSync(file, html);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`file://${file}`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(APP, 'og.png') });
await browser.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('wrote app/og.png');
