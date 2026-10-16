// Window + in-memory localStorage for tests that load app modules under
// vitest's node environment. The webostvjs SDK (src/webos/remote.ts, pulled
// in via platform.ts) assigns `window.webOS` at module scope, and the
// platform store reads `localStorage` when the store module is evaluated —
// so both must exist BEFORE the app imports run. ESM executes imports in
// declaration order: import this FIRST in such a test file. The window shim
// is reused from node-window.mjs (its import runs before the body below).
import "./node-window.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};
