/**
 * The full-mode player surface (chrome) decision — the pure part of the
 * player chrome's state machine (no DOM/webOS/Svelte imports, testable in
 * node). The screen owns the 4-second auto-hide timer; this module only
 * decides, per tick, from the flags the screen collects:
 *
 *   surfaceVisibility({paused, buffering, error, menuOpen, infoOpen})
 *     → { pinned, spinner, pauseEcho }
 *
 * The rules (acceptance A5/A6 + the locked wake/hide contract, §2.8):
 *
 *   - pinned = paused || error || menuOpen || infoOpen — while pinned the
 *     4s auto-hide timer must not run (the screen enforces the timer; this
 *     is only the decision).
 *   - spinner = buffering && !paused — the buffering spinner shows while
 *     buffering but NEVER while paused: a paused video is not buffering
 *     (A6).
 *   - pauseEcho = paused && !error — the center play-echo appears on pause
 *     (A5); an error state owns the center, so no echo there.
 *
 * A decision function, not a timer: no Date, no setTimeout, no side
 * effects.
 */

/** The flags the screen reports for the chrome's current situation. */
export interface SurfaceInput {
  /** Playback is paused (the play button is showing). */
  paused: boolean;
  /** The media is buffering (waiting on data). */
  buffering: boolean;
  /** An error state owns the screen (the error overlay is up). */
  error: boolean;
  /** One of the floating menus (source/audio/subtitles/speed) is open. */
  menuOpen: boolean;
  /** The info panel is open. */
  infoOpen: boolean;
}

/** What the chrome does with those flags, per tick. */
export interface SurfaceState {
  /** The chrome is pinned — the screen's 4s auto-hide timer must not run. */
  pinned: boolean;
  /** The buffering spinner is visible. */
  spinner: boolean;
  /** The center play-echo is visible. */
  pauseEcho: boolean;
}

export function surfaceVisibility(input: SurfaceInput): SurfaceState {
  const { paused, buffering, error, menuOpen, infoOpen } = input;
  return {
    pinned: paused || error || menuOpen || infoOpen,
    spinner: buffering && !paused,
    pauseEcho: paused && !error,
  };
}
