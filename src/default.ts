import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite-plus";
import { NATIVE_TARGET_DIR, buildNative, nativeSourceDirs, type NativeOptions } from "./native.ts";

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
  buildNative,
  discoverNativeTargets,
  hostTriple,
  moduleName,
  nativeOutputRelpath,
  nativeSourceDirs,
} from "./native.ts";
export type { NativeOptions, NativeTargetOptions } from "./native.ts";

export type Options = {
  vendor?: string[];
  dts?: boolean;
  plugins?: any[];
  /**
   * NodeSwift handler build options. Sources under `src/swift/<path>/<name>.swift` are compiled
   * automatically whenever `src/swift` exists.
   */
  native?: NativeOptions;
};

// Needs to be named `config` or else vite-plus thinks it's its `defineConfig`
export function config(options?: Options) {
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
  // tsdown treats a `watch` array in config as "enable watch mode", so only add the native
  // source dirs as extra watch paths when the user actually asked for watch mode.
  const watching = process.argv.includes("--watch") || process.argv.includes("-w");

  return {
    plugins: options?.plugins,
    pack: [
      {
        entry: {
          "package.json": "package.json",
        },
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
              hooks: {
                "build:prepare": async () => {
                  // Callers that build natives themselves (or that only need the JS output, such
                  // as a non-macOS CI job) set CHORD_SKIP_NATIVE=1.
                  if (process.env.CHORD_SKIP_NATIVE) return;
                  await buildNative(root, options?.native, { vendor: options?.vendor });
                },
              },
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
