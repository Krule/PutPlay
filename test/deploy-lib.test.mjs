// Unit tests for build/deploy-lib.mjs — the pure logic behind
// `pnpm run deploy:tv`.
//
// Scope (per owner): the deployer targets ONE TV — a rooted webOS 6 box
// without Developer Mode, where the working install is the dev/install
// luna call run from a shell with a PTY:
//
//   luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/install' \
//     '{"id":"ba.ovo.putplay","ipkUrl":"/tmp/<ipk>","subscribe":true}'
//
// Verified on the real TV: with `ssh -tt` (PTY) the service responds and
// ends in "state":"installed" + NL_APP_INSTALLED in /var/log/messages.
// Without a PTY the -i (interactive) mode no-ops silently — the service
// never sees the request — so the PTY is not a cosmetic detail.
// Everyone else installs via the Homebrew Channel app, not this script.
import test from "node:test";
import assert from "assert/strict";
import { devInstallRemote, isInstallSuccess, installLogCheck, devUninstallRemote, removeLogCheck } from "../build/deploy-lib.mjs";

test("devInstallRemote is the owner's exact working command", () => {
  assert.equal(
    devInstallRemote("ba.ovo.putplay", "ba.ovo.putplay_1.0.0_all.ipk"),
    `luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/install' '{"id":"ba.ovo.putplay","ipkUrl":"/tmp/ba.ovo.putplay_1.0.0_all.ipk","subscribe":true}'`
  );
});

test("isInstallSuccess: terminal 'installed' state", () => {
  const out =
    '{"subscribed":true,"returnValue":true}\n' +
    '{"id":"ba.ovo.putplay","statusValue":17,"details":{"state":"installing : installing","simpleStatus":"install"}}\n' +
    '{"id":"ba.ovo.putplay","statusValue":30,"details":{"state":"installed","simpleStatus":"install"}}\n';
  assert.equal(isInstallSuccess(out), true);
});

test("isInstallSuccess: still installing is NOT success", () => {
  const out =
    '{"id":"ba.ovo.putplay","statusValue":17,"details":{"state":"installing : installing"}}\n' +
    '{"id":"ba.ovo.putplay","statusValue":34,"details":{"state":"app closing"}}\n';
  assert.equal(isInstallSuccess(out), false);
});

test("isInstallSuccess: silent no-op (no PTY) is NOT success", () => {
  assert.equal(isInstallSuccess(""), false);
  assert.equal(isInstallSuccess("some unrelated shell output"), false);
});

test("installLogCheck greps appinstalld's NL_APP_INSTALLED for this id", () => {
  const cmd = installLogCheck("ba.ovo.putplay");
  assert.match(cmd, /NL_APP_INSTALLED/);
  assert.match(cmd, /ba\.ovo\.putplay/);
  assert.match(cmd, /\/var\/log\/messages/);
});

// ---------------- one-time migration (old app id) ----------------

test("devUninstallRemote: dev/uninstall luna call for the old app id", () => {
  assert.equal(
    devUninstallRemote("ba.ovo.putplay"),
    `luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/uninstall' '{"id":"ba.ovo.putplay"}'`
  );
});

test("removeLogCheck: removal is logged as NL_APP_REMOVED with the app id", () => {
  assert.equal(
    removeLogCheck("ba.ovo.putplay"),
    `grep -a NL_APP_REMOVED /var/log/messages | grep -a "ba.ovo.putplay" | tail -1`
  );
});
