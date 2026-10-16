/**
 * Vite pre-plugin: compile .svelte files (sveltePreprocess → svelte
 * compile, css:"injected") — the port of the esbuild sveltePlugin that
 * lived in build/esbuild.mjs.
 *
 * It must run with enforce:"pre". Vite's own vite:define plugin (normal
 * phase) runs an esbuild pass over ANY file whose source contains a
 * define token before user plugins get to transform it — and Svelte
 * sources contain "global" (the :global() selector), so without this
 * pre-plugin define would try to parse raw <script> markup as JS and
 * fail the build. After this plugin, define only ever sees plain JS.
 */
import { compile, preprocess } from "svelte/compiler";
import sveltePreprocess from "svelte-preprocess";

export function svelteCompiled() {
  return {
    name: "svelte-compiled",
    enforce: "pre",
    async transform(code, id) {
      if (!id.endsWith(".svelte")) return null;
      const processed = await preprocess(code, sveltePreprocess(), { filename: id });
      const finalSource = processed.code !== undefined ? processed.code : code;
      const result = compile(finalSource, {
        generate: "dom",
        filename: id,
        css: "injected", // runtime injection — the old build's contract
      });
      return { code: result.js.code, map: result.js.map };
    },
  };
}
