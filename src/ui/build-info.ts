/**
 * Build stamp — which commit produced this bundle, and whether the worktree
 * was dirty at build time. Injected by esbuild (`define: "__BUILD__"`);
 * outside a built context (unit tests, previews) it stays null.
 *
 * The webOS-visible version (appinfo.json) deliberately stays clean X.Y.Z —
 * that's what the OS compares for updates; the commit is diagnostic only
 * and lives on the Account screen.
 */
declare const __BUILD__: BuildInfo | undefined;

export interface BuildInfo {
  version: string;
  /** Short git sha, or null when the bundle wasn't built from a git checkout. */
  sha: string | null;
  /** True when the worktree had uncommitted changes at build time. */
  dirty: boolean;
}

export const BUILD_INFO: BuildInfo | null =
  typeof __BUILD__ !== "undefined" ? __BUILD__ : null;
