#!/usr/bin/env node
/**
 * Build: Svelte 4 precompile → esbuild (iife, chrome79) → js/bundle.js
 * Svelte CSS is inlined at precompile time, so no CSS step is needed.
 * The target lives in build/options.mjs (webOS 6 = Chromium 79) — do not
 * raise it without re-running the TV: a newer target makes the CSS
 * minifier emit shorthands (inset) the TV silently ignores.
 */
import * as esbuild from "esbuild";
import { browserTarget } from "./options.mjs";
import { compile, preprocess } from "svelte/compiler";
import sveltePreprocess from "svelte-preprocess";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcDir = join(root, "src");
const outDir = join(root, "js");
const outFile = join(outDir, "bundle.js");

const entry = join(srcDir, "main.ts");
const isWatch = process.argv.includes("--watch");

/**
 * Build stamp: which commit (and whether the tree was dirty) produced this
 * bundle. Shown on the Account screen; not part of the webOS version.
 */
// The release pipeline intentionally rewrites these two manifests from the
// tag (build/release-version.mjs) BEFORE the build — the tag carries the
// new version, the manifests at that commit hold the old one. That write
// is part of a clean release, not local dirt.
const VERSION_MANIFESTS = new Set(["package.json", "appinfo.json"]);

function gitBuildStamp() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd: root, stdio: "pipe" }).toString().trim();
    const status = execSync("git status --porcelain", { cwd: root, stdio: "pipe" }).toString();
    const dirty = status
      .split("\n")
      .map((line) => line.slice(3)) // "XY <path>" -> path
      .filter((path) => path.length > 0 && !VERSION_MANIFESTS.has(path))
      .length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: false }; // not a git checkout (e.g. a dist zip)
  }
}

const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const BUILD_STAMP = { version: pkgVersion, ...gitBuildStamp() };

function findSvelte(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...findSvelte(p));
    else if (extname(p) === ".svelte") out.push(p);
  }
  return out;
}

function precompileSvelte(file) {
  let source = readFileSync(file, "utf8");
  const pre = sveltePreprocess();
  const processed = pre.process
    ? pre.process({ contents: source, filename: file })
    : null;
  const finalSource = processed && processed.code !== undefined ? processed.code : source;
  const result = compile(finalSource, {
    generate: "dom",
    filename: file,
    css: "injected",
  });
  return result.js.code;
}

function sveltePlugin() {
  return {
    name: "svelte-precompile",
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        try {
          let source = readFileSync(args.path, "utf8");
          const processed = await preprocess(source, sveltePreprocess(), {
            filename: args.path,
          });
          const finalSource = processed && processed.code !== undefined ? processed.code : source;
          const result = compile(finalSource, {
            generate: "dom",
            filename: args.path,
            css: "injected",
          });
          return { contents: result.js.code, loader: "js" };
        } catch (e) {
          return { errors: [{ text: e.message, location: e.frame ? undefined : undefined }] };
        }
      });
    },
  };
}

function build() {
  return esbuild
    .build({
      entryPoints: [entry],
      outfile: outFile,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: browserTarget,
      sourcemap: false,
      minify: true,
      logLevel: "warning",
      plugins: [sveltePlugin()],
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
        global: "globalThis",
        "__BUILD__": JSON.stringify(BUILD_STAMP),
      },
    })
      .then(() => {
      const kb = (statSync(outFile).size / 1024).toFixed(1);
      const cssFile = outFile.replace(/\.js$/, ".css");
      const cssKb = existsSync(cssFile) ? ` + ${cssFile.slice(cssFile.lastIndexOf("/") + 1)} (${(statSync(cssFile).size / 1024).toFixed(0)} kB)` : "";
      const stamp = BUILD_STAMP.sha ? ` — v${pkgVersion} · ${BUILD_STAMP.sha}${BUILD_STAMP.dirty ? " (dirty)" : ""}` : "";
      console.log(`✓ built js/bundle.js (${kb} kB)${cssKb}${stamp}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

// warm the svelte compiler (avoid lazy-load warning noise)
if (isWatch) {
  const ctx = await esbuild.context({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: browserTarget,
    sourcemap: false,
    minify: false,
    logLevel: "warning",
    plugins: [sveltePlugin()],
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      global: "globalThis",
      "__BUILD__": JSON.stringify(BUILD_STAMP),
    },
  });
  await ctx.watch();
  console.log("watching…");
} else {
  await build();
}
