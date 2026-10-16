// A minimal `window` for node: the webostvjs SDK (src/webos/remote.ts,
// pulled in via platform.ts) and module-scope code in src/putio/media.ts
// reference `window` at import time. ESM executes imports in declaration
// order — import this FIRST in any test file that loads those modules.
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
