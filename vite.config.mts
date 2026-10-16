// Vite config. Phase 1 of the toolchain migration: only the vitest test
// block exists yet — the build block (Svelte plugin + chrome79 iife output)
// lands when esbuild.mjs is replaced. Vitest reads this file by default,
// so the suite runs against the same config the build will use.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    environment: "node",
    globals: false,
    // node:test had no per-test timeout by default; the packaging gate runs
    // the real ares pipeline and the build-stamp gate runs the real build.
    // 5 minutes leaves a wide margin on CI without hiding real hangs.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
