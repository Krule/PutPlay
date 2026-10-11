// Gate: the .ipk must contain the shippable app, verbatim — byte-identical
// js/bundle.js + js/bundle.css, and every static asset the UI references
// (icon.svg: the sign-in logo). This caught two real regression classes:
// (1) @webos-tools/cli's ares-package re-minifies every .js with terser by
// default, so the ipk silently contained a different bundle than what was
// built (and what the tests run) — build/package.mjs now passes --no-minify;
// (2) icon.svg was never staged into the ipk, so the logo 404d on every
// installed app while the dev simulator (which serves the repo root) still
// showed it. Skipped where the ares CLI is not installed.
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

/** Gate tests on the ares CLI: skip (not fail) where it is not installed. */
function requireAres(t) {
  let aresOk = false;
  try {
    execSync("command -v ares-package", { shell: "/bin/bash" });
    aresOk = true;
  } catch { /* not installed */ }
  if (!aresOk) {
    t.skip("ares-package not installed — skipping packaging gate");
    return false;
  }
  return true;
}

/** Run the real packaging pipeline and locate the produced .ipk. */
function packageApp() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const id = JSON.parse(readFileSync(join(root, "appinfo.json"), "utf8")).id;
  const ipkName = `${id}_${pkg.version}_all.ipk`;

  execSync("node build/package.mjs", { cwd: root, stdio: "pipe", timeout: 90_000 });
  const ipk = join(root, ipkName);
  assert.ok(existsSync(ipk), `${ipkName} not produced`);
  return { id, ipk };
}

/** Extract a member from an ipk (ar + data.tar.gz) and return its bytes.
 *  Fully explicit so BSD tar (macOS) and GNU tar (Linux CI) agree: -z (GNU
 *  refuses to auto-detect gzip), -f - (stdin), --to-stdout (portable
 *  member-to-stdout; -xO is BSD-only). */
function ipkMember(ipk, member) {
  const data = execSync(`ar p "${ipk}" data.tar.gz`, { maxBuffer: 64 * 1024 * 1024 });
  const tar = execSync("tar -xzf - --to-stdout " + JSON.stringify(member), { input: data, maxBuffer: 64 * 1024 * 1024 });
  return tar;
}

test("ipk ships the build output verbatim", { timeout: 120_000 }, (t) => {
  if (!requireAres(t)) return;

  const { id, ipk } = packageApp();
  const memberBase = `usr/palm/applications/${id}/js`;
  assert.equal(
    sha(ipkMember(ipk, `${memberBase}/bundle.js`)),
    sha(join(root, "js/bundle.js")),
    "ipk bundle.js differs from the build output"
  );
  assert.equal(
    sha(ipkMember(ipk, `${memberBase}/bundle.css`)),
    sha(join(root, "js/bundle.css")),
    "ipk bundle.css differs from the build output"
  );
});

// Gate: the sign-in screen renders its logo from icon.svg at the app root.
// If the file is not staged into the .ipk, the logo 404s on every installed
// app (Homebrew Channel, dev install alike) while the dev simulator still
// shows it — the simulator serves the repo root, where icon.svg exists.
test("ipk ships the sign-in logo (icon.svg) byte-identical", { timeout: 120_000 }, (t) => {
  if (!requireAres(t)) return;

  const { id, ipk } = packageApp();
  const logoMember = `usr/palm/applications/${id}/icon.svg`;
  let logoBytes;
  try {
    logoBytes = ipkMember(ipk, logoMember);
  } catch {
    assert.fail(
      `ipk is missing ${logoMember} — the sign-in logo (icon.svg) would 404 on the installed app`
    );
  }
  assert.equal(
    sha(logoBytes),
    sha(join(root, "icon.svg")),
    "ipk icon.svg differs from the source"
  );
});
