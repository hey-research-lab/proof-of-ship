// The few Node globals NEAR's packages read in a browser, injected by esbuild: `process` (an empty env and nextTick, no
// `versions.node`, so nothing takes a Node-only path) and `Buffer` (the `buffer` package; without it the wallet's
// transaction encoding threw "Buffer is not defined" on Open bounty, 2026-11-04).
import { Buffer } from 'buffer';

export { Buffer };

export const process = {
  env: {},
  browser: true,
  version: '',
  versions: {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};
