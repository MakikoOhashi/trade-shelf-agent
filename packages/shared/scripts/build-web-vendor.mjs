import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const ts = await import(path.join(pkgRoot, "node_modules", "typescript", "lib", "typescript.js"));

const srcMockTradeCasesPath = path.join(pkgRoot, "src", "mockTradeCases.ts");
const srcIncidentPath = path.join(pkgRoot, "src", "incident.ts");
const outPath = path.resolve(pkgRoot, "..", "..", "apps", "web", "vendor", "shared", "index.js");

const [mockTradeCasesSource, incidentSource] = await Promise.all([
  fs.readFile(srcMockTradeCasesPath, "utf8"),
  fs.readFile(srcIncidentPath, "utf8"),
]);

const compilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ES2020,
  strict: true,
  importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  removeComments: false,
};

const mockTradeCasesResult = ts.transpileModule(mockTradeCasesSource, {
  fileName: "mockTradeCases.ts",
  compilerOptions: {
    ...compilerOptions,
  },
});

const incidentResult = ts.transpileModule(incidentSource, {
  fileName: "incident.ts",
  compilerOptions: {
    ...compilerOptions,
  },
});

const banner = `// Generated from packages/shared/src/{mockTradeCases.ts,incident.ts}\n// Run: (cd packages/shared && npm run build:web-vendor)\n\n`;
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(
  outPath,
  banner + mockTradeCasesResult.outputText.trimStart() + "\n\n" + incidentResult.outputText.trimStart(),
  "utf8",
);

console.log(`wrote ${outPath}`);
