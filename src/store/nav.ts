import { writable } from "svelte/store";

/**
 * Lightweight UI navigation store — the single channel through which screens
 * request navigation. App.svelte owns the back key and routes through here.
 */
export interface NavState {
  /** library asks to go up one folder level (or to app root if at top) */
  backLevel: number; // monotonically increasing signal
}

export const nav = writable<{ backLevel: number; navToSettings: number; navToLibrary: number }>({
  backLevel: 0,
  navToSettings: 0,
  navToLibrary: 0,
});

export function requestBackLevel(): void {
  nav.update((s) => ({ ...s, backLevel: s.backLevel + 1 }));
}
export function requestSettings(): void {
  nav.update((s) => ({ ...s, navToSettings: s.navToSettings + 1 }));
}
export function requestLibrary(): void {
  nav.update((s) => ({ ...s, navToLibrary: s.navToLibrary + 1 }));
}
