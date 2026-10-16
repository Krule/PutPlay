// Vite config: the browser build (chrome79 iife → js/bundle.js +
// js/bundle.css) and the vitest test block live together because vitest
// reads this file by default — the suite and the build share one config.
//
// The build stamp (__BUILD__ define) is applied only for command ===
// "build": under vitest (command "serve") src/ui/build-info.ts must still
// see the un-replaced identifier and resolve BUILD_INFO to null (that is
// the guard test/build-stamp.test.mjs asserts).
import { defineConfig } from "vitest/config";
import { buildStamp } from "./build/build-stamp.mjs";
import { browserTarget } from "./build/options.mjs";
import { svelteCompiled } from "./build/svelte-vite-plugin.mjs";

// The browser target lives in build/options.mjs (webOS 6 = Chromium 79) —
// do not raise it without re-running the TV: a newer target makes the CSS
// minifier emit shorthands (inset) the TV silently ignores. The gate
// test/chrome79-css.test.mjs + the artifact scan in
// test/build-stamp.test.mjs enforce the invariant.
export default defineConfig(({ command }) => {
  const isBuild = command === "build";
  // The old esbuild watch defined NODE_ENV as "development" — keep that
  // contract (vite build --watch is still command "build").
  const isWatch = process.argv.includes("--watch");
  return {
    plugins: [
      // Compiles .svelte (sveltePreprocess → compile, css:"injected") —
      // the old build's contract: component <style> blocks are injected at
      // runtime, only the global theme.css import becomes the extracted
      // js/bundle.css asset. See build/svelte-vite-plugin.mjs for why it
      // must be a pre-plugin.
      svelteCompiled(),
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify(isBuild && !isWatch ? "production" : "development"),
      global: "globalThis",
      // build-time only — see the header.
      ...(isBuild ? { __BUILD__: JSON.stringify(buildStamp()) } : {}),
    },
    build: {
      target: browserTarget,
      outDir: "js",
      emptyOutDir: true,
      // one CSS asset named bundle.css (index.html links it; the ipk ships it)
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      modulePreload: false,
      minify: "esbuild",
      rollupOptions: {
        input: "src/main.ts",
        output: {
          // webOS loads js/bundle.js as a plain <script> — iife, no modules
          format: "iife",
          // the app has two runtime dynamic imports (subtitle fetch,
          // resume-seek) — fold them into the single bundle
          inlineDynamicImports: true,
          entryFileNames: "bundle.js",
          assetFileNames: "bundle.css",
        },
      },
    },
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
  };
});
