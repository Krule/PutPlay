// Deletion gate: the tile context-menu is gone.
//
// The menu (Details / Copy link / Open folder / Queue MP4 conversion) was
// removed because on a TV it was unreachable (the ⋯ dot is not a D-pad
// target) and broken (the pointer-click open path failed), and 3 of its 4
// actions were meaningless on a TV (clipboard links, a redundant
// open-folder, diagnostics). The library's color legend went with it — it
// advertised keys (Details/Sort) that were never implemented.
//
// Run: pnpm test
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("Menu.svelte component is deleted", () => {
  assert.ok(
    !existsSync(join(here, "..", "src", "ui", "components", "Menu.svelte")),
    "src/ui/components/Menu.svelte must be deleted — nothing else uses it"
  );
});

test("Library has no menu state, handlers, or markup", () => {
  const lib = read("src/ui/screens/Library.svelte");
  for (const dead of ["Menu", "menuVisible", "menuItems", "menuFor", "onMenu", "onMenuPick", "onTileMenu"]) {
    assert.ok(!lib.includes(dead), `Library.svelte still references "${dead}"`);
  }
});

test("Library's color legend is removed (it advertised unimplemented keys)", () => {
  const lib = read("src/ui/screens/Library.svelte");
  assert.ok(!/color-legend/.test(lib), "Library.svelte still contains the color-legend markup");
});

test("ItemTile has no dots button or menu plumbing", () => {
  const tile = read("src/ui/components/ItemTile.svelte");
  for (const dead of ["dots", "dotEl", "emitMenu", "onMenu"]) {
    assert.ok(!tile.includes(dead), `ItemTile.svelte still references "${dead}"`);
  }
});
