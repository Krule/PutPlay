// PutPlay signs in with the out-of-band device-code flow under its own
// registered put.io app (client id 9857) — the consent screen on the user's
// phone then shows PutPlay's registered name/icon instead of a generic
// client. The id is a single constant; the OOB request must use it, never
// the generic app_id=1.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("api.ts registers PutPlay's put.io client id (9857) as a constant", () => {
  const api = read("src/putio/api.ts");
  assert.ok(
    /export const PUTIO_CLIENT_ID = 9857/.test(api),
    "the registered client id must be a single named constant"
  );
});

test("the OOB code request uses the client id, not the generic app_id=1", () => {
  const api = read("src/putio/api.ts");
  assert.ok(
    /app_id=\$\{PUTIO_CLIENT_ID\}/.test(api),
    "requestOOBCode must build the URL from PUTIO_CLIENT_ID"
  );
  assert.ok(!/app_id=1\b/.test(api), "the generic app_id=1 must be gone from api.ts");
});
