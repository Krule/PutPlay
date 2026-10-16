// Cold-start sign-in: a stored token must be validated with exactly ONE
// /account/info call.
//
// Before this fix, loadAuth() called validateOAuth() (GET /account/info) and
// then completeAuth() → getAccountInfo() (GET /account/info AGAIN — same
// endpoint, same data, same token). Two round-trips on every cold start with
// a saved account; the second bought nothing.
//
// The storage seam is the non-webOS fallback (platform store → localStorage),
// which is what node exercises: no globalThis.luna, so isWebOS() is false.
//
// Run: pnpm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/* ---------------- in-memory localStorage shim (the storage seam) ---------------- */

class MemStorage {
  #m = new Map();
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null;
  }
  setItem(k, v) {
    this.#m.set(k, String(v));
  }
  removeItem(k) {
    this.#m.delete(k);
  }
}

/* ---------------- canned put.io /account/info ---------------- */

const ACCOUNT_INFO = {
  info: {
    account_active: true,
    account_status: "active",
    family_owner: "Test User",
    mail: "test@example.com",
    disk: { avail: 6, size: 10, used: 4 },
    download_token: "fake-dl-token",
    settings: { subtitle_languages: ["eng"] },
  },
  status: "ok",
};

/**
 * One isolated environment: a fresh localStorage, a fetch stub that records
 * every URL and answers /account/info per `mode` ("ok" | "401" | "network").
 */
function makeEnv(mode = "ok") {
  const storage = new MemStorage();
  const calls = [];
  const realLocalStorage = globalThis.localStorage;
  const realFetch = globalThis.fetch;
  globalThis.localStorage = storage;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (!u.includes("/account/info")) {
      return { ok: true, status: 200, text: async () => "{}" };
    }
    if (mode === "401") {
      return {
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ error_message: "invalid token", error_type: "invalid_token" }),
      };
    }
    if (mode === "network") throw new TypeError("fetch failed");
    return { ok: true, status: 200, text: async () => JSON.stringify(ACCOUNT_INFO) };
  };
  return {
    storage,
    calls,
    accountCalls: () => calls.filter((u) => u.includes("/account/info")),
    restore() {
      globalThis.localStorage = realLocalStorage;
      globalThis.fetch = realFetch;
    },
  };
}

/* ---------------- bundle the real store ---------------- */

// The bundled webostvjs SDK assigns `window.webOS` at module scope, so the
// window shim must exist BEFORE the bundle is required (node has no window).
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "cold-start-auth.cjs");
await build({
  entryPoints: ["src/store/auth.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const { loadAuth, auth, adoptAccount } = createRequire(import.meta.url)(out);

function readAuth() {
  let s = null;
  const un = auth.subscribe((v) => (s = v));
  un();
  return s;
}

const seedToken = (storage) => storage.setItem("putio.oauthToken", JSON.stringify("tok-1"));

/* ---------------- inner unit: adoptAccount (shared adoption step) ---------------- */

test("adoptAccount persists the token and sets the authed state from the account info", async () => {
  const env = makeEnv("ok");
  try {
    await adoptAccount("tok-1", ACCOUNT_INFO.info);
    assert.equal(env.storage.getItem("putio.oauthToken"), JSON.stringify("tok-1"), "the token must be persisted");
    const s = readAuth();
    assert.equal(s.status, "authed");
    assert.equal(s.oauthToken, "tok-1");
    assert.equal(s.downloadToken, "fake-dl-token");
    assert.equal(s.accountEmail, "test@example.com");
    assert.equal(s.accountName, "Test User");
    assert.deepEqual(s.subtitleLanguages, ["eng"]);
    assert.equal(s.disk, ACCOUNT_INFO.info.disk);
  } finally {
    env.restore();
  }
});

/* ---------------- acceptance tests ---------------- */

test("cold start with a valid stored token validates with exactly ONE /account/info call and ends authed", async () => {
  const env = makeEnv("ok");
  seedToken(env.storage);
  try {
    const ok = await loadAuth();
    assert.equal(ok, true, "loadAuth must report success for a valid token");
    assert.equal(
      env.accountCalls().length,
      1,
      `a cold start must call /account/info exactly once (got ${env.accountCalls().length} — validate and info are the same endpoint)`
    );
    assert.equal(readAuth().status, "authed");
    assert.equal(readAuth().downloadToken, "fake-dl-token");
    assert.equal(readAuth().accountEmail, "test@example.com");
  } finally {
    env.restore();
  }
});

test("cold start with a dead token (401) removes the stored token and ends unauthed", async () => {
  const env = makeEnv("401");
  seedToken(env.storage);
  try {
    const ok = await loadAuth();
    assert.equal(ok, false, "a 401 token must not be adopted");
    assert.equal(env.storage.getItem("putio.oauthToken"), null, "the dead token must be removed from storage");
    assert.equal(readAuth().status, "unauthed");
  } finally {
    env.restore();
  }
});

test("cold start with no stored token makes zero API calls", async () => {
  const env = makeEnv("ok");
  try {
    const ok = await loadAuth();
    assert.equal(ok, false);
    assert.equal(env.calls.length, 0, "nothing to validate means nothing to fetch");
    assert.equal(readAuth().status, "unauthed");
  } finally {
    env.restore();
  }
});
