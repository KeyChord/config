import path from "node:path";

type ExportConditions = Record<string, string | ExportConditions>;
type PackageManifest = {
  bin?: Record<string, string>;
  exports?: Record<string, string | ExportConditions>;
  publishConfig?: { exports?: unknown };
  types?: string;
};

const root = process.cwd();
const manifestPath = path.join(root, "package.json");
const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;

function fail(message: string): never {
  throw new Error(`[verify-package] ${message}`);
}

async function requireFile(target: unknown, label: string): Promise<string> {
  if (typeof target !== "string" || !target.startsWith("./")) {
    fail(`${label} must be a relative file path`);
  }
  if (!(await Bun.file(path.join(root, target)).exists())) {
    fail(`${label} points to missing file ${target}`);
  }
  return target;
}

if (manifest.publishConfig?.exports !== undefined) {
  fail("publishConfig.exports is not allowed; published exports must be correct in exports itself");
}

const packageExport = manifest.exports?.["."];
const conditions = typeof packageExport === "string" ? { default: packageExport } : packageExport;
if (!conditions) fail('missing exports["."]');

const runtimeTarget = await requireFile(
  conditions.import ?? conditions.default,
  'exports["."].import/default',
);
if (/\.[cm]?tsx?$/.test(runtimeTarget)) {
  fail(`runtime export must be compiled JavaScript, received ${runtimeTarget}`);
}

await requireFile(conditions.types ?? manifest.types, 'exports["."].types');

for (const [name, target] of Object.entries(manifest.bin ?? {})) {
  await requireFile(target, `bin.${name}`);
}

console.log(`[verify-package] ${runtimeTarget} and its types are publish-safe`);
