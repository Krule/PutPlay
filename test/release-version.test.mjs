// Release versioning: a git tag is the single source of truth for the
// release version. `build/release-version.mjs` maps tag vX.Y.Z onto
// package.json (drives the .ipk file name) and appinfo.json (the version
// webOS uses for app identity/updates) so the ipk, the app, and the GitHub
// release can never disagree.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseTag, compareVersions, applyVersion } from "../build/release-version.mjs";

test("parseReleaseTag: vX.Y.Z → X.Y.Z", () => {
  assert.equal(parseReleaseTag("v1.2.3"), "1.2.3");
  assert.equal(parseReleaseTag("v0.0.1"), "0.0.1");
  assert.equal(parseReleaseTag("v10.20.30"), "10.20.30");
});

test("parseReleaseTag: anything else → null (strict, no prereleases)", () => {
  for (const bad of ["1.2.3", "V1.2.3", "v1.2", "v1.2.3.4", "v1.2.3-rc1", "v1.2.3 " , "release-v1.2.3", "", null, undefined]) {
    assert.equal(parseReleaseTag(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test("compareVersions: numeric per segment, not lexicographic", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1); // "1.10" > "1.9" numerically
  assert.equal(compareVersions("0.9.0", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
});

test("applyVersion: writes the version into both manifest files, keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "putio-ver-"));
  const pkgPath = join(dir, "package.json");
  const infoPath = join(dir, "appinfo.json");
  writeFileSync(pkgPath, JSON.stringify({ name: "ba.ovo.putplay", version: "1.0.0", private: true }, null, 2) + "\n");
  writeFileSync(infoPath, JSON.stringify({ id: "ba.ovo.putplay", version: "1.0.0", title: "PutPlay" }, null, 2) + "\n");

  applyVersion("1.1.0", { packageJsonPath: pkgPath, appinfoJsonPath: infoPath });

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const info = JSON.parse(readFileSync(infoPath, "utf8"));
  assert.equal(pkg.version, "1.1.0");
  assert.equal(info.version, "1.1.0");
  // untouched fields survive
  assert.equal(pkg.name, "ba.ovo.putplay");
  assert.equal(pkg.private, true);
  assert.equal(info.id, "ba.ovo.putplay");
  assert.equal(info.title, "PutPlay");
});
