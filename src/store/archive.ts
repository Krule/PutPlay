import { writable } from "svelte/store";
import type { ZipModel } from "../putio/zip";
import type { PutFile } from "../putio/types";

/**
 * The open archive, persisted across screen round-trips — the same pattern
 * as the library store. Opening an image from inside an archive unmounts
 * the Archive screen (the App renders one screen at a time); without this
 * store, returning from the image would re-fetch the tail AND drop the
 * subfolder you were browsing in.
 */
export interface ArchiveState {
  file: PutFile | null;
  model: ZipModel | null;
  path: string; // "" = archive root
}

export const archive = writable<ArchiveState>({ file: null, model: null, path: "" });

export function setArchive(file: PutFile, model: ZipModel | null, path: string): void {
  archive.set({ file, model, path });
}

export function resetArchive(): void {
  archive.set({ file: null, model: null, path: "" });
}
