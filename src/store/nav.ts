import { writable } from "svelte/store";

/**
 * Lightweight UI navigation store — the single channel through which screens
 * request navigation. App.svelte owns the back key and routes through here.
 */
export interface NavState {
  /** library asks to go up one folder level (or to app root if at top) */
  backLevel: number; // monotonically increasing signal
  navToSettings: number;
  navToLibrary: number;
}

/** Screens the App can be showing. */
export type AppScreen = "connect" | "library" | "player" | "image" | "archive" | "settings";

/**
 * EDGE-triggered screen routing for the nav counters (a pure decision so it
 * is unit-tested — see test/nav-route.test.mjs).
 *
 * Both decisions evaluate against the INCOMING `screen`, never against a
 * value a sibling branch just assigned. This matters: the counters are
 * monotonic (they are never reset), so level-triggered conditions
 * (`navToSettings > 0`) re-fire on every store update, and two sequential
 * ifs reading a mutated `screen` revert every navigation after the first
 * Settings round-trip — the bug where the .acct button "did nothing".
 */
export function routeNav(
  prev: { navToSettings: number; navToLibrary: number },
  next: { navToSettings: number; navToLibrary: number },
  screen: AppScreen
): AppScreen {
  let out = screen;
  if (next.navToSettings !== prev.navToSettings && screen === "library") out = "settings";
  if (next.navToLibrary !== prev.navToLibrary && screen === "settings") out = "library";
  return out;
}

export const nav = writable<NavState>({
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
