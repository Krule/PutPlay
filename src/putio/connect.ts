/**
 * Back-key decisions for the Connect (sign-in) screen, extracted as pure
 * functions. BUG 6: Back did nothing on the Connect screens because they
 * never registered a remote handler (and the singleton remote kept a stale
 * handler set from whatever screen was last — now fixed by clearing it on
 * unmount in every screen).
 *
 * Intended behavior:
 *  - while waiting for approval ("pending") → Back cancels the device-code
 *    flow and returns to the sign-in choices — a half-finished flow should
 *    not exit the app.
 *  - loading → ignore (nothing to go back to).
 *  - choices screen → double-press guard, same as the library root:
 *    first press hints, second press within EXIT_WINDOW exits.
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
export function connectBackAction(status: ConnectStatus):
  | "choices"
  | "root"
  | "ignore" {
  if (status === "loading") return "ignore";
  if (status === "pending") return "choices";
  // unauthed (choices): handled by the double-press guard
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
