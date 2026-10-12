// put.io /files/list query construction — folder id 0.
//
// Folder ids are arbitrary integers: put.io's root is null, but a folder
// can legitimately have id 0 (the e2e fake's "Movies" folder does). The
// query builder used a truthiness check (`if (params.parentId)`), so
// parent_id=0 was silently DROPPED and the API returned the ROOT listing —
// "open a folder" showed the wrong folder's contents.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const out = join(mkdtempSync(join(tmpdir(), "putio-test-")), "files-list-query.cjs");
await build({
  entryPoints: ["src/putio/api.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const { listFiles } = (() => {
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  return createRequire(import.meta.url)(out);
})();

const AUTH = {
  accountEmail: "t@t",
  accountName: "T",
  oauthToken: "tok",
  scope: "files",
  downloadToken: "dl",
  disk: null,
  subtitleLanguages: ["eng"],
};

/** Capture the URL the api layer requests; answer with an empty file list. */
function captureFetch() {
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    captured = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "ok", files: [], cursor: null }),
    };
  };
  return {
    url: () => captured,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

test("listFiles sends parent_id for folder id 0 (0 is a valid folder id, not 'no folder')", async () => {
  const cap = captureFetch();
  try {
    await listFiles(AUTH, { parentId: 0, perPage: 50 });
    assert.ok(
      /parent_id=0/.test(cap.url()),
      `parent_id=0 must be sent (got: ${cap.url()}) — dropping it makes folder 0 list the ROOT`
    );
  } finally {
    cap.restore();
  }
});

test("listFiles sends parent_id for a normal folder id", async () => {
  const cap = captureFetch();
  try {
    await listFiles(AUTH, { parentId: 12345, perPage: 50 });
    assert.ok(/parent_id=12345/.test(cap.url()), `parent_id must be sent (got: ${cap.url()})`);
  } finally {
    cap.restore();
  }
});

test("listFiles omits parent_id for the root (null)", async () => {
  const cap = captureFetch();
  try {
    await listFiles(AUTH, { parentId: null, perPage: 50 });
    assert.ok(
      !/parent_id/.test(cap.url()),
      `root listing must not send parent_id (got: ${cap.url()})`
    );
  } finally {
    cap.restore();
  }
});
