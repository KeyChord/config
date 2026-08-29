#!/usr/bin/env bun
/**
 * `vpr compile` — build every distributable output folder of a chord package:
 *
 *   - `js/`                        portable JavaScript runtime artifacts (via `vp pack`)
 *   - `target/<triple>/…/`        platform-specific NodeSwift addons (via `buildNative`)
 *
 * A chord package's authored source lives in `src/` (`src/js`, `src/swift`, …); `compile`
 * turns it into the folders Chord actually loads. Native addons are built first so a JS handler
 * that imports one always sees an up-to-date module, then `vp pack` produces the JS bundle and
 * copies vendored dependencies. Run from a package directory (or `vpr -r compile` for the whole
 * workspace).
 *
 * Native options and the `vendor` list are read from the package's `vite.config.ts` via the same
 * `config()` call `vp pack` uses, so `compile` and `pack` stay in lockstep with no duplicate
 * configuration. Pass `--triple <triple>` (repeatable) to cross-build; otherwise the host triple
 * is built. `--skip-native` / `--skip-js` build only one half.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildNative, nativeSourceDirs, type NativeOptions } from "./native.ts";

type ResolvedConfig = {
  native?: NativeOptions;
  vendor?: string[];
};

function parseArgs(argv: string[]) {
  const triples: string[] = [];
  let skipNative = false;
  let skipJs = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--triple") triples.push(argv[++i]!);
    else if (arg?.startsWith("--triple=")) triples.push(arg.slice("--triple=".length));
    else if (arg === "--skip-native") skipNative = true;
    else if (arg === "--skip-js") skipJs = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: vpr compile [--triple <triple>]... [--skip-native] [--skip-js]");
      process.exit(0);
    } else {
      console.error(`[compile] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { triples, skipNative, skipJs };
}

/**
 * Loads the package's `config()` result so native options and `vendor` match `vp pack` exactly.
 * `config()` reads `process.cwd()`, so the caller must already be in the package directory.
 * Returns an empty config if there is no `vite.config.ts` (a JS-only or hand-built package).
 */
async function resolvePackageConfig(root: string): Promise<ResolvedConfig> {
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const module = await import(pathToFileURL(file).href);
    const value = await (typeof module.default === "function" ? module.default() : module.default);
    // vite-plus's defineConfig wraps the object; the config() options live under it either way.
    const options = value?.__keychordOptions ?? value?.options ?? value ?? {};
    return { native: options.native, vendor: options.vendor };
  }
  return {};
}

async function main() {
  const { triples, skipNative, skipJs } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const config = await resolvePackageConfig(root);

  if (!skipNative && nativeSourceDirs(root).length > 0) {
    const native: NativeOptions = { ...config.native };
    if (triples.length > 0) native.triples = triples;
    const results = await buildNative(root, native, { vendor: config.vendor });
    for (const result of results) {
      console.log(
        `[compile] native ${result.module} -> ${path.relative(root, result.outputDir)}`,
      );
    }
  }

  if (!skipJs) {
    // `vp pack` (through config()'s build:prepare hook) also builds native artifacts. We built
    // them above so cross-build triples and --skip flags are honored, so tell pack to skip its
    // own pass rather than rebuild from scratch. Pack produces js/ and copies vendored
    // js/chords/target folders.
    const pack = spawnSync("vp", ["pack"], {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: skipNative ? process.env : { ...process.env, CHORD_SKIP_NATIVE: "1" },
    });
    if (pack.status !== 0) {
      console.error("[compile] `vp pack` failed");
      process.exit(pack.status ?? 1);
    }
  }

  console.log("[compile] done");
}

// Only run when invoked directly (the `compile` task / `keychord-compile` bin), never on import.
if (import.meta.main) {
  main().catch((error) => {
    console.error(`[compile] ${error?.stack ?? error}`);
    process.exit(1);
  });
}
