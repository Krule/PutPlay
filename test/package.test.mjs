// Gate: the .ipk must contain EXACTLY the build output — byte-identical
// js/bundle.js. This caught a real regression class: @webos-tools/cli's
// ares-package re-minifies every .js with terser by default, so the ipk
// silently contained a different bundle than what was built (and what the
// tests run). build/package.mjs now passes --no-minify; this test keeps it
// that way. Skipped where the ares CLI is not installed.
import test from "node:test";
import assert from "assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function sha(bufOrPath) {
  return createHash("sha1").update(typeof bufOrPath === "string" ? readFileSync(bufOrPath) : bufOrPath).digest("hex");
}

/** Extract a member from an ipk (ar + data.tar.gz) and return its bytes.
 *  -xO is BSD-tar only (GNU tar treats -O as the output-device flag);
 *  --to-stdout is the portable spelling both accept during extraction. */
function ipkMember(ipk, member) {
  const data = execSync(`ar p "${ipk}" data.tar.gz`, { maxBuffer: 64 * 1024 * 1024 });
  const tar = execSync("tar -x --to-stdout " + JSON.stringify(member), { input: data, maxBuffer: 64 * 1024 * 1024 });
  return tar;
}

test("ipk ships the build output verbatim", { timeout: 120_000 }, (t) => {
  let aresOk = false;
  try {
    execSync("command -v ares-package", { shell: "/bin/bash" });
    aresOk = true;
  } catch { /* not installed */ }
  if (!aresOk) {
    t.skip("ares-package not installed — skipping packaging gate");
    return;
  }

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const id = JSON.parse(readFileSync(join(root, "appinfo.json"), "utf8")).id;
  const ipkName = `${id}_${pkg.version}_all.ipk`;

  execSync("node build/package.mjs", { cwd: root, stdio: "pipe", timeout: 90_000 });
  assert.ok(existsSync(join(root, ipkName)), `${ipkName} not produced`);

  const memberBase = `usr/palm/applications/${id}/js`;
  assert.equal(
    sha(ipkMember(join(root, ipkName), `${memberBase}/bundle.js`)),
    sha(join(root, "js/bundle.js")),
    "ipk bundle.js differs from the build output"
  );
  assert.equal(
    sha(ipkMember(join(root, ipkName), `${memberBase}/bundle.css`)),
    sha(join(root, "js/bundle.css")),
    "ipk bundle.css differs from the build output"
  );
});
