import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const ts = await import(path.join(pkgRoot, "node_modules", "typescript", "lib", "typescript.js"));

const srcPath = path.join(pkgRoot, "src", "mockTradeCases.ts");
const outPath = path.resolve(pkgRoot, "..", "..", "apps", "web", "vendor", "shared", "index.js");

const source = await fs.readFile(srcPath, "utf8");

const result = ts.transpileModule(source, {
  fileName: "mockTradeCases.ts",
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ES2020,
    strict: true,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    removeComments: false,
  },
});

const banner = `// Generated from packages/shared/src/mockTradeCases.ts\n// Run: (cd packages/shared && npm run build:web-vendor)\n\n`;
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, banner + result.outputText.trimStart(), "utf8");

console.log(`wrote ${outPath}`);
