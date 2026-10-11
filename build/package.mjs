// Stage only the shippable app files into a pristine dir, then package from
// there. ares-package 3.x's -e pattern matching is unreliable (plain names
// are ignored; .git copies throw EACCES on some systems), so staging is the
// deterministic path. Shipped: appinfo.json, index.html, icons, js/.
import { cpSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, ".pkg-staging");

// version straight from package.json so the .ipk name is never hand-stale
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const id = JSON.parse(readFileSync(join(root, "appinfo.json"), "utf8")).id;

rmSync(staging, { recursive: true, force: true });
for (const f of ["appinfo.json", "index.html", "icon.png", "largeIcon.png"]) {
  cpSync(join(root, f), join(staging, f));
}
cpSync(join(root, "js"), join(staging, "js"), { recursive: true });

// ares-package writes <id>_<version>_all.ipk into the output dir (-o).
// --no-minify: @webos-tools/cli's ares-package runs terser over every .js by
// default — a redundant second minify pass over our already-minified esbuild
// bundle (it also made the ipk contents differ from the build output, which
// made "did the deploy ship what I built?" hard to answer).
const outName = `${id}_${pkg.version}_all.ipk`;
execSync(`ares-package --no-minify -o "${root}" "${staging}"`, {
  stdio: "inherit",
  cwd: root,
});

rmSync(staging, { recursive: true, force: true });

const out = join(root, outName);
if (!existsSync(out)) {
  console.error(`package: ${outName} not produced`);
  process.exit(1);
}
const kb = readFileSync(out).length / 1024;
console.log(`\n✓ ${outName} (${kb.toFixed(0)} kB)`);
