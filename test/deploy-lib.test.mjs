// Unit tests for build/deploy-lib.mjs — the pure logic behind
// `npm run deploy:tv`.
//
// Scope (per owner): the deployer targets ONE TV — a rooted webOS 6 box
// without Developer Mode, where the working install is the dev/install
// luna call run from a shell with a PTY:
//
//   luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/install' \
//     '{"id":"io.put.lg","ipkUrl":"/tmp/<ipk>","subscribe":true}'
//
// Verified on the real TV: with `ssh -tt` (PTY) the service responds and
// ends in "state":"installed" + NL_APP_INSTALLED in /var/log/messages.
// Without a PTY the -i (interactive) mode no-ops silently — the service
// never sees the request — so the PTY is not a cosmetic detail.
// Everyone else installs via the Homebrew Channel app, not this script.
import test from "node:test";
import assert from "assert/strict";
import { devInstallRemote, isInstallSuccess, installLogCheck } from "../build/deploy-lib.mjs";

test("devInstallRemote is the owner's exact working command", () => {
  assert.equal(
    devInstallRemote("io.put.lg", "io.put.lg_1.0.0_all.ipk"),
    `luna-send-pub -i -w 2000 'luna://com.webos.appInstallService/dev/install' '{"id":"io.put.lg","ipkUrl":"/tmp/io.put.lg_1.0.0_all.ipk","subscribe":true}'`
  );
});

test("isInstallSuccess: terminal 'installed' state", () => {
  const out =
    '{"subscribed":true,"returnValue":true}\n' +
    '{"id":"io.put.lg","statusValue":17,"details":{"state":"installing : installing","simpleStatus":"install"}}\n' +
    '{"id":"io.put.lg","statusValue":30,"details":{"state":"installed","simpleStatus":"install"}}\n';
  assert.equal(isInstallSuccess(out), true);
});

test("isInstallSuccess: still installing is NOT success", () => {
  const out =
    '{"id":"io.put.lg","statusValue":17,"details":{"state":"installing : installing"}}\n' +
    '{"id":"io.put.lg","statusValue":34,"details":{"state":"app closing"}}\n';
  assert.equal(isInstallSuccess(out), false);
});

test("isInstallSuccess: silent no-op (no PTY) is NOT success", () => {
  assert.equal(isInstallSuccess(""), false);
  assert.equal(isInstallSuccess("some unrelated shell output"), false);
});

test("installLogCheck greps appinstalld's NL_APP_INSTALLED for this id", () => {
  const cmd = installLogCheck("io.put.lg");
  assert.match(cmd, /NL_APP_INSTALLED/);
  assert.match(cmd, /io\.put\.lg/);
  assert.match(cmd, /\/var\/log\/messages/);
});
