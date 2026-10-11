/**
 * Back-key decisions for the Connect (sign-in) screen, extracted as pure
 * functions. BUG 6: Back did nothing on the Connect screens because they
 * never registered a remote handler (and the singleton remote kept a stale
 * handler set from whatever screen was last — now fixed by clearing it on
 * unmount in every screen).
 *
 * Intended behavior:
 *  - pending (QR screen) and unauthed (error/spinner frame) → double-press
 *    guard, same as the library root: first press hints, second press within
 *    EXIT_WINDOW exits the app. There is no sign-in choices screen to go
 *    back to — the QR screen IS the connect screen. The approval flow is
 *    bounded (TTL + 429 stop), so it self-terminates in the background.
 *  - loading → ignore (nothing to go back to).
 *
 * The screen has a single sign-in method (device code + QR) — the paste-a
 * token mode was removed because a TV remote can't type.
 */

export type ConnectStatus = "loading" | "unauthed" | "pending" | "authed";

/**
 * Which action a Back press takes on the Connect screen.
 * "root" means the caller should run the double-press guard (doublePress)
 * to decide hint vs exit.
 */
export function connectBackAction(status: ConnectStatus): "root" | "ignore" {
  if (status === "loading") return "ignore";
  // pending (QR) and unauthed (error/spinner frame) both exit via the guard
  return "root";
}

/** Double-press window (ms) shared with the library root exit guard. */
export const EXIT_WINDOW = 2000;

export interface DoublePressState {
  lastRootBackAt: number;
}

/**
 * Double-press exit guard. Mutates state.lastRootBackAt. Returns the action
 * to take: "hint" (arm the exit) or "exit" (double-press detected).
 */
export function doublePress(state: DoublePressState, now: number): "hint" | "exit" {
  if (now - state.lastRootBackAt < EXIT_WINDOW) {
    state.lastRootBackAt = 0; // re-arm
    return "exit";
  }
  state.lastRootBackAt = now;
  return "hint";
}
