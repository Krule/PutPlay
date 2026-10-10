/**
 * What OK/press does on the Player screen — extracted as a pure decision so
 * both remotes share one contract (test/player-ok.test.mjs), mirroring
 * libraryOkAction.
 *
 * A Magic-Remote pointer click already lands on the focused element's own
 * handler. The common 5-way remote's OK key must activate the SPATIALLY
 * FOCUSED control (a control-bar button, a pick-row, a panel button) — and
 * only with nothing focused does it fall back to the screen default:
 * play/pause. (The old handler checked the overlay flags only: with an
 * overlay open it was a dead end because no row could be focused, and a
 * focused control was ignored.)
 */
export type PlayerOkAction = "activate-focused" | "toggle-play";

export function playerOkAction(hasFocusedControl: boolean): PlayerOkAction {
  if (hasFocusedControl) return "activate-focused";
  return "toggle-play";
}
