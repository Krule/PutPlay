/**
 * Single source of truth for the build's browser target.
 *
 * webOS 6.0 ships Chromium 79 — the TV is the only device that matters.
 * The build's esbuild minifier (Vite's build.target) honors this for BOTH
 * the JS output and the CSS MINIFIER: the minifier folds longhands into
 * shorthands only when the target knows them (top/right/bottom/left →
 * `inset`, Chrome 87+). Targeting a newer browser — or a bare `es2019`
 * the minifier treats permissively — makes it emit `inset`, which
 * Chromium 79 silently ignores: every inset vanishes, the layout breaks,
 * and there is no console error. That bug shipped twice (the player
 * rendered off-screen on the TV while every desktop test passed) before
 * this file existed.
 *
 * test/chrome79-css.test.mjs re-runs the minifier with THIS target and
 * fails the suite if the output contains a shorthand the TV can't read.
 */
export const browserTarget = ["chrome79"];
