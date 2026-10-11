/**
 * Player control-bar auto-hide rule.
 *
 * On a TV the player already fills the screen, so the chrome (title,
 * progress, buttons) hides itself while the video plays and wakes on
 * pointer movement or D-pad presses. It must STAY visible whenever hiding
 * would strand the user: paused (mid-decision), error, or an overlay
 * panel open.
 */
export interface ControlsState {
  paused: boolean;
  error: boolean;
  panelOpen: boolean;
}

/** True when the control bar may not auto-hide. */
export function controlsPinned(s: ControlsState): boolean {
  return s.paused || s.error || s.panelOpen;
}
