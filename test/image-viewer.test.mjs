// Image viewer (v1, no zoom): fit-to-screen + Left/Right browse + Back.
//
// The TV's Chromium 79 decodes a fixed set of image formats — the app must
// only OPEN what it can actually display (honesty contract): HEIC/HEIF and
// SVG are NOT offered, they fall through to the "can't display" toast like
// any other unplayable file.
//
// Contract (pure decisions in src/putio/image.ts):
//   1. isImageFile: content_type image/* wins; extension fallback when the
//      type is missing; only decodable raster formats (jpeg/png/gif/webp/bmp).
//   2. stepIndex: browse the viewer's target list; no wrap at either
//      end; an index outside the list navigates nowhere.
//      buildLibraryTargets: the folder's decodable images -> ViewerTargets
//      that load through the signed stream URL.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

const dir = mkdtempSync(join(tmpdir(), "imgviewer-"));
await build({
  entryPoints: [join(here, "..", "src/putio/image.ts")],
  bundle: true,
  format: "cjs",
  target: "es2019",
  outfile: join(dir, "bundle.cjs"),
});
const req = createRequire(import.meta.url);
const img = req(join(dir, "bundle.cjs"));

const file = (name, content_type) => ({ id: 1, name, content_type, is_folder: 0 });

test("isImageFile: content_type image/* for the decodable rasters", () => {
  assert.equal(img.isImageFile(file("a.jpg", "image/jpeg")), true);
  assert.equal(img.isImageFile(file("a.png", "image/png")), true);
  assert.equal(img.isImageFile(file("a.gif", "image/gif")), true);
  assert.equal(img.isImageFile(file("a.webp", "image/webp")), true);
  assert.equal(img.isImageFile(file("a.bmp", "image/bmp")), true);
});

test("isImageFile: unknown image subtypes are NOT displayable on Chromium 79", () => {
  // HEIC/HEIF: no decoder in webOS 6's webview. SVG: not v1 (script/animation
  // edge cases; the app only opens what it can prove).
  assert.equal(img.isImageFile(file("a.heic", "image/heic")), false);
  assert.equal(img.isImageFile(file("a.heif", "image/heif")), false);
  assert.equal(img.isImageFile(file("a.svg", "image/svg+xml")), false);
});

test("isImageFile: extension fallback when content_type is missing", () => {
  assert.equal(img.isImageFile(file("a.jpeg", "")), true);
  assert.equal(img.isImageFile(file("a.PNG", null)), true);
  assert.equal(img.isImageFile(file("a.heic", "")), false);
  assert.equal(img.isImageFile(file("notes.txt", "")), false);
});

test("isImageFile: folders and non-images are never images", () => {
  assert.equal(img.isImageFile({ id: 2, name: "pics", content_type: "", is_folder: 1 }), false);
  assert.equal(img.isImageFile(file("a.mp4", "video/mp4")), false);
});

/* ---------------- stepIndex: the viewer's browse primitive ---------------- */
test("stepIndex: steps the target list, no wrap at either end", () => {
  assert.equal(img.stepIndex(0, 3, 1), 1);
  assert.equal(img.stepIndex(1, 3, 1), 2);
  assert.equal(img.stepIndex(2, 3, 1), null);
  assert.equal(img.stepIndex(1, 3, -1), 0);
  assert.equal(img.stepIndex(0, 3, -1), null);
  assert.equal(img.stepIndex(0, 0, 1), null);
  assert.equal(img.stepIndex(5, 3, 1), null, "an index outside the list goes nowhere (honest)");
});

test("buildLibraryTargets: the folder's images become viewer targets", () => {
  const files = [
    { id: 1, name: "a.png", content_type: "image/png", size: 10 },
    { id: 2, name: "v.mp4", content_type: "video/mp4", size: 99 },
    { id: 3, name: "b.heic", content_type: "image/heic", size: 5 },
    { id: 4, name: "c.jpg", content_type: "image/jpeg", size: 20 },
  ];
  const t = img.buildLibraryTargets(files, { oauthToken: "t", downloadToken: "d" });
  assert.deepEqual(t.map((x) => x.name), ["a.png", "c.jpg"]);
  assert.equal(t[0].size, 10);
  assert.equal(typeof t[0].load, "function");
  return Promise.resolve(t[0].load()).then((src) => {
    assert.ok(src.indexOf("/files/1/stream") !== -1, "library targets load through the signed stream URL");
    assert.ok(src.indexOf("oauth_token=d") !== -1, "the download token signs the URL");
  });
});

/* ================= UI wiring (source contracts) ================= */
const lib = read("src/ui/screens/Library.svelte");
const app = read("src/ui/App.svelte");
const navSrc = read("src/store/nav.ts");
const fake = read("test/e2e/fake-api.js");

/** Top-level script function body (same convention as the player panel tests). */
function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name}() must exist`);
  const end = src.indexOf("\n  }", start);
  assert.ok(end > start, `function ${name}() must be closed`);
  return src.slice(start, end);
}

test("nav: the app can be showing the image screen", () => {
  assert.ok(
    /export type AppScreen = .*\bimage\b/.test(navSrc),
    'AppScreen must include "image"'
  );
});

test("library: images open the viewer BEFORE the can't-play toast", () => {
  assert.ok(
    /from "\.\.\/\.\.\/putio\/image"/.test(lib),
    "Library must use the pure isImageFile decision"
  );
  const open = bodyOf(lib, "onOpenFile");
  const atImage = open.indexOf("isImageFile");
  const atToast = open.indexOf("can't be played");
  assert.ok(atImage >= 0, "onOpenFile must test isImageFile");
  assert.ok(
    atImage < atToast,
    "the image branch must precede the 'can't be played' toast (and the archive branch)"
  );
  assert.ok(
    /dispatch\("open-image"/.test(open),
    "opening an image must dispatch open-image with the file"
  );
});

test("app: routes to the image screen and back to the library", () => {
  assert.ok(/import Image from ".\/screens\/Image.svelte"/.test(app));
  assert.ok(
    /screen === "image"/.test(app),
    "App must render the image screen"
  );
  const open = bodyOf(app, "onOpenImage");
  assert.ok(/screen = "image"/.test(open), "onOpenImage must set screen = image");
  assert.ok(
    /pushBackLevel\(\)/.test(open),
    "entering the viewer must protect the level (platform back must not exit)"
  );
  const back = bodyOf(app, "onGlobalBack");
  assert.ok(
    /screen === "image"/.test(back) && /screen = "library"/.test(back),
    "the app-level back path must return from the viewer to the library"
  );
});

test("viewer: honest loading/error states over the target's own load()", () => {
  const viewer = read("src/ui/screens/Image.svelte");
  assert.ok(
    viewer.indexOf("streamURL") === -1,
    "the viewer must not build URLs itself — targets carry their load() (library AND archive images)"
  );
  assert.ok(/\.load\(\)/.test(viewer), "the viewer must call the active target's load()");
  assert.ok(/on\:error=/.test(viewer), "the <img> must handle decode/load failure");
  assert.ok(
    /retry|loadImage|reload/.test(viewer),
    "the error state must offer a retry (never a silent blank)"
  );
});

test("viewer: remote keys — back exits, left/right browse the folder", () => {
  const viewer = read("src/ui/screens/Image.svelte");
  assert.ok(/setHandlers\(\{/.test(viewer));
  assert.ok(/onBack/.test(viewer), "Back must be handled");
  assert.ok(
    /onNavigate/.test(viewer),
    "Left/Right must browse the folder's images"
  );
  assert.ok(
    /stepIndex\(/.test(viewer),
    "browsing must go through the pure stepIndex decision"
  );
  assert.ok(
    /dispatch\("back"\)/.test(viewer),
    "the viewer has no sub-levels: Back dispatches back to the App"
  );
  assert.ok(
    /clearHandlers\(\)/.test(viewer),
    "handlers must be cleared on unmount (no stale handlers leak — BUG 5 contract)"
  );
});

test("viewer: fit-to-screen rendering (no scroll, no crop)", () => {
  const viewer = read("src/ui/screens/Image.svelte");
  assert.ok(
    /object-fit:\s*contain/.test(viewer),
    "the image must fit the screen without cropping"
  );
});

test("e2e fake: serves real images for the image files", () => {
  assert.ok(
    /content_type: "image\/png"/.test(fake),
    "the fake must list image files (content_type image/png)"
  );
  assert.ok(
    /wall-\d\.png/.test(fake),
    "the fake /stream route must serve the PNG assets for the image ids"
  );
});
