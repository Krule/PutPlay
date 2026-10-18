/**
 * build-fresh shim: build-once-per-tree-state for the gate tests that run a
 * REAL production build (build-stamp, package).
 *
 * treeKey: a hash of the tree's CONTENT — short sha + `git diff HEAD` + the
 * contents of every untracked (non-ignored) file. Same key ⇒ identical vite
 * inputs ⇒ a js/ built for that key is the output this tree would build.
 *
 * withFreshBuild: under the build lock (shims/build-lock.mjs), rebuild js/
 * only when no build for the current key exists; then run fn (still under
 * the lock). The state file lives in the OS temp dir (stateFile) — never in
 * the repo (js/ is staged into the ipk verbatim).
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeKey, stateFile, withFreshBuild } from "./shims/build-fresh.mjs";

const out = (cmd, dir) => execSync(cmd, { cwd: dir, stdio: "pipe" }).toString().trim();
const scratchRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "fresh-"));
  writeFileSync(join(d, "one.txt"), "one\n");
  // ignore js/ exactly like the real repo (.gitignore:6): the build's output
  // must not count as tree content, or every build would "change" the tree
  writeFileSync(join(d, ".gitignore"), "js/\n");
  out("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm one", d);
  return d;
};
// a fake "build": stamps a counter file + the artifacts withFreshBuild expects
const FAKE_BUILD =
  "node -e \"require('fs').appendFileSync(process.argv[1],'x');require('fs').mkdirSync('js',{recursive:true});require('fs').writeFileSync('js/bundle.js','b');require('fs').writeFileSync('js/bundle.css','c')\"";

test("treeKey: deterministic for an unchanged tree", () => {
  const d = scratchRepo();
  assert.equal(treeKey(d), treeKey(d));
});

test("treeKey: changes when a tracked file is edited", () => {
  const d = scratchRepo();
  const before = treeKey(d);
  appendFileSync(join(d, "one.txt"), "\nmore\n");
  assert.notEqual(treeKey(d), before);
});

test("treeKey: changes when an untracked file is added or its content changes", () => {
  const d = scratchRepo();
  const before = treeKey(d);
  writeFileSync(join(d, "loose.txt"), "v1");
  const withFile = treeKey(d);
  assert.notEqual(withFile, before);
  writeFileSync(join(d, "loose.txt"), "v2");
  assert.notEqual(treeKey(d), withFile);
});

test("withFreshBuild: builds once per tree state, reuses while it holds, rebuilds after an edit", async () => {
  const d = scratchRepo();
  // OUTSIDE the repo: the fake build's side effect must not change the tree
  // state it keys on
  const counter = join(tmpdir(), `fresh-counter-${process.pid}-${Math.random().toString(16).slice(2)}`);
  rmSync(counter, { force: true });
  const runs = () => readFileSync(counter, "utf8").length;
  const call = () =>
    withFreshBuild(d, async () => "ran", { build: `${FAKE_BUILD} ${JSON.stringify(counter)}` });
  assert.equal(await call(), "ran");
  assert.equal(runs(), 1, "first call builds");
  await call();
  assert.equal(runs(), 1, "second call on the same tree reuses the build");
  appendFileSync(join(d, "one.txt"), "\nedit\n");
  await call();
  assert.equal(runs(), 2, "an edit changes the tree state → rebuild");
});

test("withFreshBuild: deleted artifacts force a rebuild even with a matching state file", async () => {
  const d = scratchRepo();
  const counter = join(tmpdir(), `fresh-counter2-${process.pid}-${Math.random().toString(16).slice(2)}`);
  rmSync(counter, { force: true });
  const call = () =>
    withFreshBuild(d, async () => "ran", { build: `${FAKE_BUILD} ${JSON.stringify(counter)}` });
  await call();
  rmSync(stateFile(d), { force: true }); // fresh machine: no state
  await call();
  assert.equal(readFileSync(counter, "utf8").length, 2, "no state file → build");
  rmSync(join(d, "js"), { recursive: true }); // output vanished
  await call();
  assert.equal(readFileSync(counter, "utf8").length, 3, "missing js/ → build");
});
