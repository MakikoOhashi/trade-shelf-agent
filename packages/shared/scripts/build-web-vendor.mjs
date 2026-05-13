import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const ts = await import(path.join(pkgRoot, "node_modules", "typescript", "lib", "typescript.js"));

const srcMockTradeCasesPath = path.join(pkgRoot, "src", "mockTradeCases.ts");
const srcIncidentPath = path.join(pkgRoot, "src", "incident.ts");
const srcIngestPath = path.join(pkgRoot, "src", "ingest.ts");
const srcMockInputsPath = path.join(pkgRoot, "src", "mockInputs.ts");
const outPath = path.resolve(pkgRoot, "..", "..", "apps", "web", "vendor", "shared", "index.js");

const [mockTradeCasesSource, incidentSource, ingestSource, mockInputsSource] = await Promise.all([
  fs.readFile(srcMockTradeCasesPath, "utf8"),
  fs.readFile(srcIncidentPath, "utf8"),
  fs.readFile(srcIngestPath, "utf8"),
  fs.readFile(srcMockInputsPath, "utf8"),
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

const ingestResult = ts.transpileModule(ingestSource, {
  fileName: "ingest.ts",
  compilerOptions: {
    ...compilerOptions,
  },
});

const mockInputsResult = ts.transpileModule(mockInputsSource, {
  fileName: "mockInputs.ts",
  compilerOptions: {
    ...compilerOptions,
  },
});

const banner = `// Generated from packages/shared/src/{mockTradeCases.ts,incident.ts,ingest.ts,mockInputs.ts}\n// Run: (cd packages/shared && npm run build:web-vendor)\n\n`;
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(
  outPath,
  [
    banner,
    mockTradeCasesResult.outputText.trimStart(),
    "",
    incidentResult.outputText.trimStart(),
    "",
    ingestResult.outputText.trimStart(),
    "",
    mockInputsResult.outputText.trimStart(),
  ].join("\n"),
  "utf8",
);

console.log(`wrote ${outPath}`);
