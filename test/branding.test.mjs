// Rebrand gate: the app identifies as PutPlay everywhere a name is shown —
// launcher (appinfo.json title), page (index.html), the put.io consent
// screen during device-code login (api.ts clientName), and the settings
// subline. The package id is "ba.ovo.putplay": it is the webOS app
// identity that updates are keyed on, and changing it AFTER the first
// release breaks updates — it may only change in the pre-release window.
import test from "node:test";
import assert from "assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("appinfo.json: launcher title is PutPlay, package id untouched", () => {
  const info = JSON.parse(read("appinfo.json"));
  assert.equal(info.title, "PutPlay");
  assert.equal(info.id, "ba.ovo.putplay");
});

test("index.html: page title is PutPlay", () => {
  assert.match(read("index.html"), /<title>PutPlay<\/title>/);
});

test("api.ts: OOB device flow presents as PutPlay on the put.io consent screen", () => {
  assert.match(read("src/putio/api.ts"), /requestOOBCode\(clientName = "PutPlay"\)/);
});

test("Settings.svelte: subline names PutPlay and keeps the put.io reference", () => {
  assert.match(read("src/ui/screens/Settings.svelte"), /PutPlay/);
});
