import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "keychord-chords-plugin-")));
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

test.each([
  ["com/apple/finder/macos.toml", "/f"],
  ["com/raycast/macos/macos.toml", "//(.*)"],
  ["bobko/aerospace/macos.toml", ".q"],
  ["com/example/App/macos.toml", "?/m"],
  ["com/example/App/macos.toml", '?/m"1-9"'],
  ["com/example/App/macos.toml", "?;i"],
  ["web.toml", ";n"],
  ["base.toml", "/f"],
  ["other.macos.toml", "/f"],
  ["com/chords/macos.toml", "/f"],
])("rejects global binding %s: %s outside root macos.toml", async (file, key) => {
  const root = await fixture({
    [`chords/${file}`]: `name = 'Misplaced'\n[chords]\n'${key}' = { name = 'Global' }\n`,
  });
  await expect(bundle(root)).rejects.toThrow(
    `global chord ${JSON.stringify(key)} in ${path.join(root, "chords", file)} must be defined in the package's root chords/macos.toml`,
  );
});

test("allows local chords and hints in application and shared files", async () => {
  const source = `name = 'Local'
[chords]
g = { name = 'Goto' }
'?g' = { name = 'Goto hint' }
'?0' = { name = 'Core hint' }
'?"1-9"' = { name = 'Repeat count' }
'?(a-z)' = { name = 'Letters' }
'?f"1-7"' = { name = 'Folding levels' }
'é' = { name = 'Unicode letter' }
`;
  const pkg = await bundle(
    await fixture({
      "chords/base.toml": source,
      "chords/com/example/App/macos.toml": source,
    }),
  );
  expect(pkg.chords["base.toml"].chords).toEqual(pkg.chords.com.example.App["macos.toml"].chords);
});

test("allows global chords and symbol-prefixed hints in root macos.toml", async () => {
  const pkg = await bundle(
    await fixture({
      "chords/macos.toml": `name = 'Global'
[on.monitor]
file = 'monitor.js'
[chords]
'?/ms' = { name = 'Monitor: Size' }
'/ms(.+)' = { name = 'Monitor: Size (Set)', '@input:monitor' = ['$1'] }
`,
    }),
  );
  expect(pkg.chords["macos.toml"].chords).toHaveProperty("?/ms");
  expect(pkg.chords["macos.toml"].on.monitor).toEqual({ file: "monitor.js" });
});

test.each(["@keychord/chords-menu", "chords-menu"])(
  "allows %s globals in its vendored root but rejects its nested globals",
  async (vendor) => {
    const root = await fixture({
      [`node_modules/${vendor}/chords/macos.toml`]:
        "name = 'Menu'\n[chords]\n'-m' = { name = 'Menu' }\n",
    });
    await expect(bundle(root, [vendor])).resolves.toBeDefined();
    const nested = `node_modules/${vendor}/chords/com/example/App/macos.toml`;
    await mkdir(path.dirname(path.join(root, nested)), { recursive: true });
    await writeFile(path.join(root, nested), "name = 'App'\n[chords]\n'-m' = { name = 'Menu' }\n");
    await expect(bundle(root, [vendor])).rejects.toThrow(
      "must be defined in the package's root chords/macos.toml",
    );
  },
);

test("allows copied scoped vendors to keep their own global root", async () => {
  await expect(
    bundle(
      await fixture({
        "chords/@keychord/chords-menu/chords/macos.toml":
          "name = 'Menu'\n[chords]\n'-m' = { name = 'Menu' }\n",
      }),
    ),
  ).resolves.toBeDefined();
});
