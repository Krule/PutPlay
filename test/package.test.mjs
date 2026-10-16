// Gate: the .ipk must contain the shippable app, verbatim — byte-identical
// js/bundle.js + js/bundle.css, and every static asset the UI references
// (icon.svg: the sign-in logo). This caught two real regression classes:
// (1) @webos-tools/cli's ares-package re-minifies every .js with terser by
// default, so the ipk silently contained a different bundle than what was
// built (and what the tests run) — build/package.mjs now passes --no-minify;
// (2) icon.svg was never staged into the ipk, so the logo 404d on every
// installed app while the dev simulator (which serves the repo root) still
// showed it. Skipped where the ares CLI is not installed.
import { test } from "vitest";
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

/** Gate the packaging tests on the ares CLI: skip (not fail) where it is
 *  not installed — checked once at collection time. */
let ARES_OK = false;
try {
  execSync("command -v ares-package", { shell: "/bin/bash" });
  ARES_OK = true;
} catch { /* not installed */ }

/** Run the real packaging pipeline and locate the produced .ipk. */
function packageApp() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const id = JSON.parse(readFileSync(join(root, "appinfo.json"), "utf8")).id;
  const ipkName = `${id}_${pkg.version}_all.ipk`;

  // Build first: package.mjs stages js/ VERBATIM, so the gate only means
  // "the ipk ships the build output" when that output is fresh from the
  // source. Without this, a stale js/ (last release's build) is what gets
  // staged, and the compare fails on stale-vs-fresh hashes, not a bug.
  // The hashes are snapshotted right after the build — a concurrent test
  // (build-stamp rebuilds js/) can republish the files any time after, and
  // the assertion must hold against the build this ipk was made from.
  execSync("node build/esbuild.mjs", { cwd: root, stdio: "pipe", timeout: 60_000 });
  const bundleSha = sha(join(root, "js/bundle.js"));
  const cssSha = sha(join(root, "js/bundle.css"));
  execSync("node build/package.mjs", { cwd: root, stdio: "pipe", timeout: 90_000 });
  const ipk = join(root, ipkName);
  assert.ok(existsSync(ipk), `${ipkName} not produced`);
  return { id, ipk, bundleSha, cssSha };
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

test.runIf(ARES_OK)("ipk ships the build output verbatim", { timeout: 120_000 }, () => {
  const { id, ipk, bundleSha, cssSha } = packageApp();
  const memberBase = `usr/palm/applications/${id}/js`;
  assert.equal(
    sha(ipkMember(ipk, `${memberBase}/bundle.js`)),
    bundleSha,
    "ipk bundle.js differs from the build output"
  );
  assert.equal(
    sha(ipkMember(ipk, `${memberBase}/bundle.css`)),
    cssSha,
    "ipk bundle.css differs from the build output"
  );
});

// Gate: the sign-in screen renders its logo from icon.svg at the app root.
// If the file is not staged into the .ipk, the logo 404s on every installed
// app (Homebrew Channel, dev install alike) while the dev simulator still
// shows it — the simulator serves the repo root, where icon.svg exists.
test.runIf(ARES_OK)("ipk ships the sign-in logo (icon.svg) byte-identical", { timeout: 120_000 }, () => {
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

/* ---------------- OLED screensaver (the C1's power-off report) -----------
 * webOS OLEDs run a screensaver a few minutes after the last user action.
 * A comic page can sit on screen for minutes at a time — the official
 * manifest opt-in (screenSaverProperties, type 2: 30-minute timeout,
 * reset by key input) is the documented app-side answer. Type 2, not 3:
 * a reader who keeps turning pages keeps full brightness; type 3 dims
 * and never resets. (The FULL power-off the C1 saw is the TV-side
 * CEC/energy setting — no app API can reach it.)
 */
test("appinfo.json: the OLED screensaver is opted into as type 2 (key-reset, 30 min)", () => {
  const ai = JSON.parse(readFileSync(join(root, "appinfo.json"), "utf8"));
  assert.deepEqual(
    ai.screenSaverProperties,
    { preferredType: 2 },
    "type 2: brightness + timer reset on key input (the reader's case); NOT type 3 (gallery dim, no reset)"
  );
  assert.ok(!("useGalleryMode" in ai), "gallery mode is the type-3 switch — a comic reader is not a gallery");
});
