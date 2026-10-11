// Gate: the Homebrew Channel repo.json entry must match the community schema
// exactly (verified against youtube-webos-cobalt-adfree's live repo.json),
// and updates must REPLACE the existing PutPlay entry, never duplicate it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoEntry, upsertPackage } from "../build/repo-entry.mjs";

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
};

test("repoEntry matches the Homebrew Channel schema field-for-field", () => {
  const e = repoEntry(input);
  // top level
  assert.deepEqual(Object.keys(e).sort(), ["iconUri", "id", "manifest", "shortDescription", "title"]);
  assert.equal(e.id, input.appId);
  assert.equal(e.title, input.title);
  assert.equal(e.shortDescription, input.shortDescription);
  assert.equal(e.iconUri, input.iconUri);
  // manifest
  const m = e.manifest;
  assert.deepEqual(
    Object.keys(m).sort(),
    ["id", "iconUri", "ipkHash", "ipkSize", "ipkUrl", "rootRequired", "sourceUrl", "title", "type", "version"].sort(),
  );
  assert.equal(m.id, input.appId);
  assert.equal(m.version, input.version);
  assert.equal(m.type, "web"); // appinfo.json type — this is a web app, not native
  assert.equal(m.title, input.title);
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
