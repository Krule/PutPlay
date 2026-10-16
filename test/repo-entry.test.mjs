// Gate: the Homebrew Channel repo.json entry must match the official
// webosbrew/docs schemas (HomebrewRepository + HomebrewPackageManifest)
// field-for-field — including fullDescriptionUrl (the TV detail panel's rich
// description) and manifest.appDescription — and updates must REPLACE the
// existing PutPlay entry, never duplicate it. The full description page must
// exist, survive the channel's DOMPurify pass, and reference only images
// that ship in the repo.
// Schema cross-checked against the live immich entry on repo.webosbrew.org.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoEntry, upsertPackage } from "../build/repo-entry.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const input = {
  appId: "ba.ovo.putplay",
  title: "PutPlay",
  version: "1.0.0",
  iconUri: "https://raw.githubusercontent.com/Krule/PutPlay/main/largeIcon.png",
  sourceUrl: "https://github.com/Krule/PutPlay",
  ipkUrl: "https://github.com/Krule/PutPlay/releases/download/v1.0.0/ba.ovo.putplay_1.0.0_all.ipk",
  sha256: "ab".repeat(32),
  size: 123456,
  shortDescription: "put.io browser & player for webOS.",
  appDescription: "Browses your put.io library and plays the original file on the big screen.",
  fullDescriptionUrl: "https://raw.githubusercontent.com/Krule/PutPlay/main/docs/full-description.html",
};

test("repoEntry matches the Homebrew Channel schema field-for-field", () => {
  const e = repoEntry(input);
  // top level — fullDescriptionUrl is how the TV detail panel gets the rich
  // description (DetailsPanel fetches it, DOMPurify-sanitizes, renders into
  // moonstone BodyText; falls back to shortDescription when absent)
  assert.deepEqual(Object.keys(e).sort(), ["fullDescriptionUrl", "iconUri", "id", "manifest", "shortDescription", "title"]);
  assert.equal(e.id, input.appId);
  assert.equal(e.title, input.title);
  assert.equal(e.shortDescription, input.shortDescription);
  assert.equal(e.fullDescriptionUrl, input.fullDescriptionUrl);
  assert.equal(e.iconUri, input.iconUri);
  // manifest — appDescription is the detail-page line per the official
  // HomebrewPackageManifest schema
  const m = e.manifest;
  assert.deepEqual(
    Object.keys(m).sort(),
    ["appDescription", "id", "iconUri", "ipkHash", "ipkSize", "ipkUrl", "rootRequired", "sourceUrl", "title", "type", "version"].sort(),
  );
  assert.equal(m.id, input.appId);
  assert.equal(m.version, input.version);
  assert.equal(m.type, "web"); // appinfo.json type — this is a web app, not native
  assert.equal(m.title, input.title);
  assert.equal(m.appDescription, input.appDescription);
  assert.equal(m.iconUri, input.iconUri);
  assert.equal(m.sourceUrl, input.sourceUrl);
  assert.equal(m.rootRequired, false);
  assert.equal(m.ipkUrl, input.ipkUrl);
  assert.deepEqual(m.ipkHash, { sha256: input.sha256 });
  assert.equal(m.ipkSize, input.size);
});

test("upsertPackage replaces the existing entry (never duplicates on re-release)", () => {
  const first = { packages: [repoEntry(input)] };
  const bumped = { ...input, version: "1.0.1", sha256: "cd".repeat(32), ipkUrl: input.ipkUrl.replace("v1.0.0/", "v1.0.1/").replace("1.0.0_", "1.0.1_") };
  const second = upsertPackage(first, repoEntry(bumped));
  assert.equal(second.packages.length, 1);
  assert.equal(second.packages[0].manifest.version, "1.0.1");
  assert.equal(second.packages[0].manifest.ipkHash.sha256, "cd".repeat(32));
});

test("upsertPackage appends to a repo that has other publishers' entries", () => {
  const other = { id: "org.example.other", title: "Other", shortDescription: "x", iconUri: "https://example.com/i.png", manifest: {} };
  const repo = upsertPackage({ packages: [other] }, repoEntry(input));
  assert.equal(repo.packages.length, 2);
  assert.equal(repo.packages[0].id, "org.example.other"); // untouched, order preserved
  assert.equal(repo.packages[1].id, "ba.ovo.putplay");
});

// Gate: the full description page the Homebrew Channel detail panel fetches
// must exist in the repo, survive the channel's DOMPurify pass (style/script/
// form/input/button tags are STRIPPED — a description that depends on a
// <style> block renders as unstyled text), and reference only images that
// ship in the repo (raw.githubusercontent URLs must resolve after push).
test("full-description.html exists, is DOMPurify-safe, and its images ship in the repo", () => {
  const page = readFileSync(join(root, "docs", "full-description.html"), "utf8");
  for (const tag of ["<style", "<script", "<button", "<input", "<form"]) {
    assert.ok(!page.toLowerCase().includes(tag), `forbidden tag ${tag}> in full-description.html — DOMPurify strips it in the channel`);
  }
  const srcs = [...page.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 3, "the description must embed real app screenshots (img tags)");
  for (const src of srcs) {
    const local = src.replace(/^https:\/\/raw\.githubusercontent\.com\/Krule\/PutPlay\/main\//, "");
    assert.ok(!src.includes("://") || src.startsWith("https://raw.githubusercontent.com/Krule/PutPlay/main/"),
      `image ${src} must come from the repo's raw.githubusercontent main branch`);
    assert.ok(existsSync(join(root, local)), `screenshot ${local} must ship in the repo`);
  }
});
