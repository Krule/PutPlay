// Release versioning: the git tag is the single source of truth for the
// release version. This maps tag vX.Y.Z onto package.json (drives the .ipk
// file name in build/package.mjs) and appinfo.json (the version webOS uses
// for app identity/updates) so the ipk, the installed app, and the GitHub
// release can never disagree.
//
// CI usage:   node build/release-version.mjs v1.2.3
// Local use:  same — then revert the two manifests if you don't release.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** "v1.2.3" → "1.2.3"; anything else (no v, prerelease, garbage) → null. */
export function parseReleaseTag(tag) {
  const m = String(tag).match(TAG_RE);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric per-segment compare: -1 | 0 | 1. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Write `version` into both manifest files (paths kept injectable for tests). */
export function applyVersion(version, { packageJsonPath, appinfoJsonPath }) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const info = JSON.parse(readFileSync(appinfoJsonPath, "utf8"));
  pkg.version = version;
  info.version = version;
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(appinfoJsonPath, JSON.stringify(info, null, 2) + "\n");
}

// main: run with a tag argument
if (process.argv[2] !== undefined) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tag = process.argv[2];
  const version = parseReleaseTag(tag);
  if (!version) {
    console.error(`release-version: "${tag}" is not a release tag (expected vX.Y.Z, e.g. v1.2.3)`);
    process.exit(1);
  }
  const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (compareVersions(version, current) < 0) {
    console.error(`release-version: tag ${tag} (${version}) is older than the current version ${current} — re-tag with a higher version`);
    process.exit(1);
  }
  applyVersion(version, {
    packageJsonPath: join(root, "package.json"),
    appinfoJsonPath: join(root, "appinfo.json"),
  });
  console.log(`✓ version ${version} applied to package.json + appinfo.json`);
}
