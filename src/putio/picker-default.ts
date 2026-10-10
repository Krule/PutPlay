/**
 * Which row a Player pick overlay should put the D-pad focus on when it
 * opens (a pure decision so it is unit-tested — see
 * test/picker-default.test.mjs).
 *
 * TV convention: focus the row that is currently selected, so OK re-confirms
 * the active choice and arrows explore the alternatives. Disabled rows (e.g.
 * "put.io MP4" when unavailable) are never a target.
 */

export interface PickerRowState {
  selected?: boolean;
  disabled?: boolean;
}

export function pickerDefaultIndex(rows: PickerRowState[]): number {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].selected && !rows[i].disabled) return i;
  }
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].disabled) return i;
  }
  return -1;
}

/**
 * Read a row element's selected/disabled state from the markup the overlays
 * already maintain: the `.sel` class marks the active choice and
 * `data-focus-disabled="true"` marks an unavailable option.
 */
export function rowFocusState(
  el: HTMLElement,
  selClass = "sel"
): PickerRowState {
  return {
    selected: el.classList.contains(selClass),
    disabled: el.dataset.focusDisabled === "true",
  };
}
