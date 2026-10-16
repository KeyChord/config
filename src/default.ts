import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vite-plus";
import { chordTestRuntime } from "@keychord/chordtest/vitest";
import { NATIVE_TARGET_DIR, buildNative, nativeSourceDirs, type NativeOptions } from "./native.ts";
import { nativeAddonPlugin } from "./native-plugin.ts";
import { packageChordsPlugin } from "./chords-plugin.ts";

// Path to the `compile` task script, next to this module. In development that is `compile.ts`
// (source); in a published install it is the bundled `compile.mjs`. Resolve to whichever exists.
function resolveCompileScript(): string {
  for (const name of ["compile.mjs", "compile.js", "compile.ts"]) {
    const candidate = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fall back to the source name; the task will error loudly if it is genuinely missing.
  return fileURLToPath(new URL("./compile.ts", import.meta.url));
}
const compileScript = resolveCompileScript();

export {
  addonName,
  buildNative,
  discoverNativeTargets,
  hasNativeManifest,
  hostTriple,
  manifestPath,
  nativeSourceDirs,
} from "./native.ts";
export type { NativeOptions, NativeTarget } from "./native.ts";
export { nativeAddonPlugin } from "./native-plugin.ts";
export type { NativeAddonPluginOptions } from "./native-plugin.ts";
export { packageChordsPlugin } from "./chords-plugin.ts";
export type { ChordsTree, PackageChordsPluginOptions } from "./chords-plugin.ts";

export type Options = {
  vendor?: string[];
  dts?: boolean;
  plugins?: any[];
  /**
   * NodeSwift build options. Every dynamic library product in the package's `Package.swift` is
   * compiled automatically whenever that manifest exists; the manifest itself declares Swift
   * dependencies, platform and language mode, so these are build-orchestration options only.
   */
  native?: NativeOptions;
};

// Needs to be named `config` or else vite-plus thinks it's its `defineConfig`
export function config(options?: Options) {
  const runtime = chordTestRuntime();
  const srcJsDirpath = path.join(process.cwd(), "src/js");
  let entry: string | Record<string, string> = {};

  if (fs.existsSync(srcJsDirpath) && fs.statSync(srcJsDirpath).isDirectory()) {
    for (const filename of fs.readdirSync(srcJsDirpath).filter((file) => file.endsWith(".ts"))) {
      entry[path.parse(filename).name] = path.join(srcJsDirpath, filename);
    }
  }

  // const specifier = fileURLToPath(import.meta.resolve('@keychord/eslint-plugin-package-json'))
  // const eslintBinPath = path.join(fileURLToPath(import.meta.resolve('eslint/package.json')), '../bin/eslint.js');

  const root = process.cwd();
  const nativeDirs = nativeSourceDirs(root);
  const nativeOptions = { ...options?.native };
  // The compile CLI forwards its --triple overrides to its vp pack subprocess.
  if (process.env.CHORD_NATIVE_TRIPLES) {
    const triples: unknown = JSON.parse(process.env.CHORD_NATIVE_TRIPLES);
    if (!Array.isArray(triples) || triples.some((triple) => typeof triple !== "string")) {
      throw new Error("[chord-native] CHORD_NATIVE_TRIPLES must be a JSON array of target triples");
    }
    nativeOptions.triples = triples;
  }
  let nativeBuild: ReturnType<typeof buildNative> | undefined;
  const nativeHooks = nativeDirs.length
    ? {
        "build:prepare": async () => {
          if (process.env.CHORD_SKIP_NATIVE) return;
          await (nativeBuild ??= buildNative(root, nativeOptions, { vendor: options?.vendor }));
        },
      }
    : undefined;
  const nativeBuildWatcher: Plugin = {
    name: "keychord-native-build",
    watchChange(id) {
      if (
        nativeDirs.some((directory) => id === directory || id.startsWith(`${directory}${path.sep}`))
      ) {
        nativeBuild = undefined;
      }
    },
  };
  // tsdown treats a `watch` array in config as "enable watch mode", so only add the native
  // source dirs as extra watch paths when the user actually asked for watch mode.
  const watching = process.argv.includes("--watch") || process.argv.includes("-w");

  return {
    ...runtime,
    plugins: [...runtime.plugins, ...(options?.plugins ?? [])],
    pack: [
      {
        entry: {
          "package.json": "package.json",
        },
        // `js/package.json.js` also exports the parsed `chords/` tree as `chords`.
        plugins: [packageChordsPlugin({ root, vendor: options?.vendor })],
        copy: options?.vendor?.flatMap((packageName) => {
          return [
            { from: `node_modules/${packageName}/js`, to: `js/${packageName}` },
            { from: `node_modules/${packageName}/chords`, to: `chords/${packageName}` },
            // Vendored native modules resolve to `target/@scope/name/target/<triple>/<relpath>/`.
            ...(fs.existsSync(`node_modules/${packageName}/${NATIVE_TARGET_DIR}`)
              ? [
                  {
                    from: `node_modules/${packageName}/${NATIVE_TARGET_DIR}`,
                    to: `${NATIVE_TARGET_DIR}/${packageName}`,
                  },
                ]
              : []),
          ];
        }),
        outDir: "js",
        fixedExtension: false,
        // NodeSwift addons are compiled ahead of the JS bundle.
        ...(nativeDirs.length > 0
          ? {
              hooks: nativeHooks,
              ...(watching ? { watch: nativeDirs } : {}),
            }
          : {}),
      },
      ...Object.values(entry).map((entry) => ({
        entry,
        clean: false,
        outDir: "js",
        dts: options?.dts,
        fixedExtension: false,
        ...(nativeDirs.length > 0
          ? {
              hooks: nativeHooks,
              plugins: [nativeBuildWatcher, nativeAddonPlugin({ root, ...nativeOptions })],
              ...(watching ? { watch: nativeDirs } : {}),
            }
          : {}),
        deps: {
          // This is needed to remove the warning from console output, but tsdown types don't like for some reason so we cast it to never
          onlyBundle: false as never,
          alwaysBundle: [/.*/],
          // `chord` is Chord's built-in module; `bun:*`/`node:*` are provided by the runtime.
          neverBundle: ["chord", /^bun:/, /^node:/, ...(options?.vendor ?? [])],
        },
      })),
    ] satisfies UserConfig["pack"],
    // Raw options so `vpr compile` reads the same native/vendor config as `vp pack`.
    __keychordOptions: options ?? {},
    run: {
      tasks: {
        // `vpr compile` builds every dist folder: js/ and target/<triple>/…/.
        // Not cached: native output is machine/triple-specific and vp pack has its own cache.
        compile: {
          command: `bun ${JSON.stringify(compileScript)}`,
          cache: false,
        },
      },
    },
    // run: {
    //   tasks: {
    //     fix: {
    //       // Sadly, oxlint does not support fixing JSON files (see https://oxc.rs/compatibility.html), and oxfmt does not (yet) support plugins, so we fall back to using ESLint
    //       command: `
    //         ${eslintBinPath} **/package.json \
    //           --no-config-lookup \
    //           --fix \
    //           --plugin ${specifier} \
    //           --rule '@keychord/package-json/type: error'
    //       `,
    //     }
    //   }
    // },
    // lint: {
    // }
  };
}
