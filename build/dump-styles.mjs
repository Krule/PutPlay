// One-shot: compile every .svelte with external CSS → /tmp/scoped-audit.css
// so the ux_audit tool can audit the COMPLETE stylesheet, not just theme.css.
// Mirrors build/esbuild.mjs preprocessing exactly (sveltePreprocess → strip TS).
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { sveltePreprocess } from "svelte-preprocess";
import { preprocess, compile } from "svelte/compiler";

const files = execSync("find src -name '*.svelte'").toString().split("\n").filter(Boolean);
let out = "";
for (const f of files) {
  const source = readFileSync(f, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: f });
  const finalSource = processed && processed.code !== undefined ? processed.code : source;
  const result = compile(finalSource, { css: "external" });
  if (result.css && result.css.code) out += `/* ${f} */\n` + result.css.code + "\n";
}
writeFileSync("/tmp/scoped-audit.css", out);
console.log(`wrote /tmp/scoped-audit.css (${out.length} bytes, ${files.length} components)`);
