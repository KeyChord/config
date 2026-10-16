import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import { build } from "vite-plus/pack";
import { nativeAddonPlugin } from "../native-plugin.ts";

const ARM = "aarch64-apple-darwin";
const INTEL = "x86_64-apple-darwin";
const roots: string[] = [];
const execute = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(triples = [ARM], names = ["tray"], targetDir = "target") {
  const root = await mkdtemp(path.join(tmpdir(), "keychord-native-plugin-"));
  roots.push(root);
  await mkdir(path.join(root, "src/js"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"native-plugin-test","type":"module"}');
  for (const triple of triples) {
    for (const name of names) {
      const directory = path.join(root, targetDir, triple, name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${name}.node`), `${triple} ${name} addon`);
      await writeFile(path.join(directory, "libNodeAPI.dylib"), `${triple} ${name} runtime`);
    }
  }
  await writeFile(
    path.join(root, "src/js/handler.ts"),
    `export type NativeAddon = { run(): void };
${names.map((name) => `export function ${name}(): NativeAddon { return require("./${name}.node"); }`).join("\n")}
`,
  );
  return { root, triples, targetDir };
}

async function bundle(options: Awaited<ReturnType<typeof fixture>>) {
  await build({
    config: false,
    cwd: options.root,
    entry: "src/js/handler.ts",
    outDir: "js",
    fixedExtension: false,
    plugins: [nativeAddonPlugin(options)],
    logLevel: "silent",
  });
  return readFile(path.join(options.root, "js/handler.js"), "utf8");
}

async function addonFile(root: string, triple: string, name = "tray") {
  const directory = path.join(root, "js/native", triple, name);
  const file = (await readdir(directory)).find((file) => file.endsWith(".node"));
  expect(file).toBeDefined();
  return path.join(directory, file!);
}

test("bundles a lazy native require in TypeScript and preserves its matching runtime", async () => {
  const options = await fixture();
  const code = await bundle(options);
  const binary = await addonFile(options.root, ARM);
  expect(await readFile(binary, "utf8")).toBe(`${ARM} tray addon`);
  expect(await readFile(path.join(path.dirname(binary), "libNodeAPI.dylib"), "utf8")).toBe(
    `${ARM} tray runtime`,
  );
  expect(code).not.toContain(path.join(options.root, "target"));
  expect(code).not.toContain("ROLLUP_FILE_URL");
  expect(code).not.toContain("resolveNative");
  expect(code).toContain("import.meta.url");
  // Importing the handler must not try to dlopen the deliberately fake binary.
  const script = path.join(options.root, "lazy-check.mjs");
  await writeFile(script, 'import { tray } from "./js/handler.js"; console.log(typeof tray);');
  expect((await execute(process.execPath, [script])).stdout.trim()).toBe("function");
});

test("ships the shared accessibility runtime beside the addon for dynamic loading", async () => {
  const options = await fixture();
  await writeFile(
    path.join(options.root, "target", ARM, "tray/libAXorcistRuntime.dylib"),
    "shared accessibility runtime",
  );
  await bundle(options);
  const binary = await addonFile(options.root, ARM);
  expect(await readFile(path.join(path.dirname(binary), "libAXorcistRuntime.dylib"), "utf8")).toBe(
    "shared accessibility runtime",
  );
});

test("keeps architectures and addon runtimes separate and selects at runtime", async () => {
  const options = await fixture([ARM, INTEL], ["tray", "menu"]);
  const code = await bundle(options);
  expect(code).toContain('"darwin-arm64"');
  expect(code).toContain('"darwin-x64"');
  for (const triple of options.triples) {
    for (const name of ["tray", "menu"]) {
      const binary = await addonFile(options.root, triple, name);
      expect(await readFile(binary, "utf8")).toBe(`${triple} ${name} addon`);
      expect(await readFile(path.join(path.dirname(binary), "libNodeAPI.dylib"), "utf8")).toBe(
        `${triple} ${name} runtime`,
      );
    }
  }
  const script = path.join(options.root, "intel-check.mjs");
  await writeFile(
    script,
    'Object.defineProperty(process, "platform", { value: "darwin" });\nObject.defineProperty(process, "arch", { value: "x64" });\nconst { tray } = await import("./js/handler.js");\ntray();',
  );
  // The fake binary cannot load, but the attempted path must belong to the Intel target.
  await expect(execute(process.execPath, [script])).rejects.toThrow(
    path.join("native", INTEL, "tray"),
  );
});

test("reports an unsupported runtime target without attempting to load another architecture", async () => {
  const options = await fixture();
  await bundle(options);
  const script = path.join(options.root, "unsupported-check.mjs");
  await writeFile(
    script,
    'Object.defineProperty(process, "platform", { value: "freebsd" });\nconst { tray } = await import("./js/handler.js");\ntray();',
  );
  await expect(execute(process.execPath, [script])).rejects.toThrow(
    "[chord-native] tray has no addon for freebsd-",
  );
});

test("fails the build when either the addon or its NodeSwift runtime is missing", async () => {
  for (const filename of ["tray.node", "libNodeAPI.dylib"]) {
    const options = await fixture();
    await rm(path.join(options.root, "target", ARM, "tray", filename));
    await expect(bundle(options)).rejects.toThrow(filename);
  }
});

test("supports a custom target directory and changes the filename when the addon changes", async () => {
  const options = await fixture([ARM], ["tray"], "prebuilt");
  await bundle(options);
  const first = await addonFile(options.root, ARM);
  await writeFile(path.join(options.root, "prebuilt", ARM, "tray/tray.node"), "updated addon");
  await bundle(options);
  const second = await addonFile(options.root, ARM);
  expect(second).not.toBe(first);
  expect(await readFile(second, "utf8")).toBe("updated addon");
});

test("does not shadow an actual source-side native file", async () => {
  const options = await fixture();
  await writeFile(path.join(options.root, "src/js/tray.node"), "existing local addon");
  await bundle(options);
  const assets = await readdir(path.join(options.root, "js/assets"));
  expect(await readFile(path.join(options.root, "js/assets", assets[0]), "utf8")).toBe(
    "existing local addon",
  );
  await expect(readdir(path.join(options.root, "js/native"))).rejects.toThrow();
});

test("supports default imports in TypeScript without importing the binary as ESM", async () => {
  const options = await fixture();
  await writeFile(
    path.join(options.root, "src/js/handler.ts"),
    'import addon from "./tray.node";\nexport default addon;',
  );
  const code = await bundle(options);
  expect(code).toContain("nativeRequire(fileURLToPath(nativeFile))");
  expect(code).not.toMatch(/import\s+.*from\s+["'][^"']+\.node["']/);
  expect(await addonFile(options.root, ARM)).toBeDefined();
});

test("config() enables native resolution automatically and forwards compile target overrides", async () => {
  const options = await fixture([ARM, INTEL]);
  await writeFile(path.join(options.root, "Package.swift"), "// prebuilt test package");
  const configSource = fileURLToPath(new URL("../default.ts", import.meta.url));
  await writeFile(
    path.join(options.root, "vite.config.ts"),
    `import { config } from ${JSON.stringify(configSource)};\nexport default config();`,
  );
  await execute("vp", ["pack"], {
    cwd: options.root,
    env: {
      ...process.env,
      CHORD_SKIP_NATIVE: "1",
      CHORD_NATIVE_TRIPLES: JSON.stringify([ARM, INTEL]),
    },
  });
  for (const triple of options.triples) expect(await addonFile(options.root, triple)).toBeDefined();
});
