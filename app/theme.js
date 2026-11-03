/*
 * The reader's theme: System (the default, following prefers-color-scheme), Light or Dark. Loaded in <head> before
 * the page paints, so a chosen theme never flashes; the choice is kept in this browser only (localStorage).
 */
(function () {
  var KEY = 'pos.theme';
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode or storage blocked */ }
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  var NEXT = { system: 'light', light: 'dark', dark: 'system' };
  var WORDS = { system: 'follows your system', light: 'light', dark: 'dark' };
  function mode() { var t = root.getAttribute('data-theme'); return t === 'light' || t === 'dark' ? t : 'system'; }
  function label(btn) {
    var m = mode();
    btn.setAttribute('data-mode', m);
    btn.setAttribute('aria-label', 'Theme: ' + WORDS[m] + '. Switch to ' + (NEXT[m] === 'system' ? 'your system setting' : NEXT[m]));
    btn.title = 'Theme: ' + WORDS[m];
  }
  function wire() {
    var btn = document.getElementById('theme');
    if (!btn) return;
    label(btn);
    btn.addEventListener('click', function () {
      var next = NEXT[mode()];
      if (next === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', next);
      try { if (next === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch (e) { /* kept for this visit only */ }
      label(btn);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
