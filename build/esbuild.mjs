#!/usr/bin/env node
/**
 * Build: Svelte 4 precompile → esbuild (iife, es2019) → js/bundle.js
 * Svelte CSS is inlined at precompile time, so no CSS step is needed.
 */
import * as esbuild from "esbuild";
import { compile, preprocess } from "svelte/compiler";
import sveltePreprocess from "svelte-preprocess";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const srcDir = join(root, "src");
const outDir = join(root, "js");
const outFile = join(outDir, "bundle.js");

const entry = join(srcDir, "main.ts");
const isWatch = process.argv.includes("--watch");

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
      target: ["es2019"],
      sourcemap: false,
      minify: true,
      logLevel: "warning",
      plugins: [sveltePlugin()],
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
        global: "globalThis",
      },
    })
      .then(() => {
      const kb = (statSync(outFile).size / 1024).toFixed(1);
      console.log(`✓ built js/bundle.js (${kb} kB) + js/theme.css`);
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
    target: ["es2019"],
    sourcemap: false,
    minify: false,
    logLevel: "warning",
    plugins: [sveltePlugin()],
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      global: "globalThis",
    },
  });
  await ctx.watch();
  console.log("watching…");
} else {
  await build();
}
