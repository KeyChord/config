import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import { build } from "vite-plus/pack";
import { packageChordsPlugin } from "../chords-plugin.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "keychord-chords-plugin-"));
  roots.push(root);
  await writeFile(path.join(root, "package.json"), '{"name":"chords-plugin-test","type":"module"}');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

async function bundle(root: string, vendor?: string[]) {
  await build({
    config: false,
    cwd: root,
    entry: { "package.json": "package.json" },
    outDir: "js",
    fixedExtension: false,
    plugins: [packageChordsPlugin({ root, vendor })],
    logLevel: "silent",
  });
  return import(`${pathToFileURL(path.join(root, "js/package.json.js")).href}?${Date.now()}`);
}

test("exports the chords/ tree with each TOML file parsed under its folders", async () => {
  const root = await fixture({
    "chords/macos.toml": "name = 'Root'\n[chords]\n'/d' = { name = 'Dock' }\n",
    "chords/com/google/Chrome/macos.toml": "name = 'Chrome'\n",
    "chords/com/google/Chrome/beta/macos.toml": "name = 'Chrome Beta'\n",
    "chords/readme.md": "not a chord file",
    "chords/.hidden/macos.toml": "name = 'Hidden'\n",
  });
  const pkg = await bundle(root);
  const chords = {
    com: {
      google: {
        Chrome: {
          beta: { "macos.toml": { name: "Chrome Beta" } },
          "macos.toml": { name: "Chrome" },
        },
      },
    },
    "macos.toml": { name: "Root", chords: { "/d": { name: "Dock" } } },
  };
  expect(pkg.default).toEqual({ name: "chords-plugin-test", type: "module", chords });
  expect(pkg.chords).toEqual(chords);
  // Only the bundled module is augmented; the source manifest stays untouched.
  expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))).not.toHaveProperty(
    "chords",
  );
});

test("reads vendored chords from their source instead of the previous build's copy", async () => {
  const root = await fixture({
    "chords/macos.toml": "name = 'Dock'\n",
    "chords/@keychord/chords-menu/chords/macos.toml": "name = 'Stale menu'\n",
    "node_modules/@keychord/chords-menu/chords/macos.toml": "name = 'Menu'\n",
  });
  const pkg = await bundle(root, ["@keychord/chords-menu"]);
  expect(pkg.chords).toEqual({
    "@keychord": { "chords-menu": { chords: { "macos.toml": { name: "Menu" } } } },
    "macos.toml": { name: "Dock" },
  });
});

test("exports an empty tree for a package without chords", async () => {
  const pkg = await bundle(await fixture({}));
  expect(pkg.chords).toEqual({});
});

test("fails the build on invalid TOML and names the file", async () => {
  const root = await fixture({ "chords/macos.toml": "name = \n" });
  await expect(bundle(root)).rejects.toThrow(path.join("chords", "macos.toml"));
});
