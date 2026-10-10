import { writable, get } from "svelte/store";
import type { Writable } from "svelte/store";
import { store } from "../webos/platform";
import {
  type ConfigState,
  normalizeConfig,
  pickAudioTrack,
  matchLang,
  pickSubtitleTrack,
} from "../putio/config";
export type { ConfigState };
export { pickAudioTrack, matchLang, pickSubtitleTrack };

/**
 * The Config-page state as a Svelte store: default source, preferred audio
 * language, preferred subtitle language, subtitle display scale. Loaded from
 * / persisted to webOS appData (localStorage in the browser preview).
 */
export const config: Writable<ConfigState> = writable<ConfigState>(normalizeConfig(null));

let loaded = false;

/** Load persisted preferences (idempotent). Call once from App onMount. */
export async function loadConfig(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const saved = await store.get<Partial<ConfigState>>("putio.config", {});
  config.set(normalizeConfig(saved));
}

/** Persist the current preferences. */
export async function saveConfig(): Promise<void> {
  await store.set("putio.config", get(config));
}
