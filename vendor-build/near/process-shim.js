// The few Node `process` fields NEAR's packages read in a browser: an empty env and nextTick. No `versions.node`, so
// nothing takes a Node-only path.
export const process = {
  env: {},
  browser: true,
  version: '',
  versions: {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
};
