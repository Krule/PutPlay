// update-repo.mjs — CI glue: compute the Homebrew Channel repo.json entry for
// a freshly packaged ipk and write the updated repo.json to the out path.
//
// Usage (release workflow, on the release runner):
//   node build/update-repo.mjs \
//     --app-id ba.ovo.putplay \
//     --title "PutPlay" \
//     --version 1.0.0 \
//     --tag v1.0.0 \
//     --ipk ba.ovo.putplay_1.0.0_all.ipk \
//     --repo https://github.com/Krule/PutPlay \
//     --current repo.json \          # current repo.json (fetched from main)
//     --out repo.json
//
// Pure logic lives in repo-entry.mjs (unit-tested); this file only does I/O.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { repoEntry, upsertPackage } from "./repo-entry.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const appId = arg("app-id");
const title = arg("title");
const version = arg("version");
const tag = arg("tag");
const ipkPath = arg("ipk");
const repoUrl = arg("repo");
const currentPath = arg("current");
const outPath = arg("out");

const SHORT_DESCRIPTION = "put.io browser & player for webOS — stream your files straight to the TV.";
// One-line detail-page description (HomebrewPackageManifest.schema: "shown in
// the application details page") + the full description page the TV's
// DetailsPanel fetches and renders (DOMPurify-sanitized; see repo-entry.mjs).
const APP_DESCRIPTION = "Browses your put.io library and plays the original file on the big screen — MKV/MP4 as uploaded, with put.io MP4/HLS fallback, subtitles, and audio switching.";
const FULL_DESCRIPTION_URL = repoUrl.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/main/docs/full-description.html";

// hash + size of the real artifact — never hand-entered
const ipkBytes = readFileSync(ipkPath);
const sha256 = createHash("sha256").update(ipkBytes).digest("hex");
const size = ipkBytes.length;

const iconUri = repoUrl.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/main/largeIcon.png";
const ipkUrl = `${repoUrl}/releases/download/${tag}/${appId}_${version}_all.ipk`;

const current = existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, "utf8")) : { packages: [] };
const next = upsertPackage(current, repoEntry({ appId, title, version, iconUri, sourceUrl: repoUrl, ipkUrl, sha256, size, shortDescription: SHORT_DESCRIPTION, appDescription: APP_DESCRIPTION, fullDescriptionUrl: FULL_DESCRIPTION_URL }));

writeFileSync(outPath, JSON.stringify(next, null, 2) + "\n");
console.log(`repo.json: ${next.packages.length} package(s); ${appId} v${version} sha256=${sha256.slice(0, 12)}… size=${size}`);
