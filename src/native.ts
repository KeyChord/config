/**
 * NodeSwift addon builds for Chord packages.
 *
 * Each package owns a real SwiftPM manifest at its root:
 *
 *   Package.swift                   dependencies, language mode, platform, products
 *   Sources/<Module>/**.swift       one directory per addon, named after its product
 *
 * Every `.dynamic` library product is built as one NodeSwift addon. Output mirrors the
 * product's output name for each target triple:
 *
 *   target/<triple>/<name>/<name>.node
 *
 * NodeSwift supplies the Node-API bridge and produces a `.node` file plus its shared
 * `libNodeAPI.dylib` runtime. AXorcist users also ship the shared `libAXorcistRuntime.dylib`.
 * Keeping these libraries dynamic is important when Chord loads multiple
 * addons: statically linking it into every addon registers duplicate Swift/Objective-C classes
 * in one process. For the same reason product names must be unique across every chord package
 * loaded together -- `assertUniqueModuleNames` enforces that at build time.
 *
 * The manifest is the single source of truth for everything SwiftPM understands. `NativeOptions`
 * only carries build-orchestration concerns that have no SwiftPM equivalent (which triples to
 * build, release vs debug, where to stage output).
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build as buildNodeSwift } from "node-swift";

const NODE_API_VERSION = 8;
const NODE_SWIFT_RUNTIME_FILENAME = "libNodeAPI.dylib";
const NODE_SWIFT_PACKAGE_IDENTITY = "node-swift";
const MANIFEST_FILENAME = "Package.swift";

export const NATIVE_TARGET_DIR = "target";
export const NATIVE_MODULE_EXTENSION = "node";

export type NativeOptions = {
  /** Rust-style target triples to build (default: the host triple). */
  triples?: string[];
  /** Release (default) or debug builds. */
  optimize?: boolean;
  /** Directory receiving built addons, relative to the package root (default "target"). */
  targetDir?: string;
  /** Scratch directory for SwiftPM build products (default "node_modules/.cache/chord/native"). */
  scratchDir?: string;
  /**
   * Skip the check that the manifest's pinned node-swift version matches the installed npm
   * `node-swift`. Only useful while deliberately testing an unreleased bridge.
   */
  allowNodeSwiftVersionMismatch?: boolean;
};

export type NativeTarget = {
  /** Swift product/module name, as declared in Package.swift. */
  module: string;
  /** Addon filename stem and path below `target/<triple>/`, e.g. `menu`. */
  name: string;
};

/** Rust-style triple of the machine running the build. */
export function hostTriple(): string {
  if (process.platform === "darwin") {
    return os.arch() === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "win32") {
    return os.arch() === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return os.arch() === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

function isDir(value: string): boolean {
  return fs.existsSync(value) && fs.statSync(value).isDirectory();
}

export function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILENAME);
}

export function hasNativeManifest(root: string): boolean {
  return fs.existsSync(manifestPath(root));
}

/**
 * Existing native source roots, used by pack/compile to decide whether to build.
 * A package builds natives when it has a SwiftPM manifest.
 */
export function nativeSourceDirs(root: string): string[] {
  if (!hasNativeManifest(root)) return [];
  const sources = path.join(root, "Sources");
  return isDir(sources) ? [sources, manifestPath(root)] : [manifestPath(root)];
}

type DumpedPackage = {
  name: string;
  products: { name: string; type: Record<string, unknown> }[];
  dependencies: {
    sourceControl?: {
      identity: string;
      requirement?: Record<string, unknown>;
    }[];
  }[];
};

/** Parse the package manifest with SwiftPM itself, so we never re-implement its semantics. */
function dumpPackage(root: string): DumpedPackage {
  let stdout: string;
  try {
    stdout = execFileSync("swift", ["package", "dump-package"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error: any) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    throw new Error(`[chord-native] could not read ${manifestPath(root)}:\n${detail}`);
  }
  return JSON.parse(stdout);
}

/** `.dynamic` library products are the addons; anything else in the manifest is support code. */
export function discoverNativeTargets(root: string): NativeTarget[] {
  if (!hasNativeManifest(root)) return [];
  const dumped = dumpPackage(root);
  const targets = dumped.products
    .filter((product) => {
      const library = (product.type as any)?.library;
      return Array.isArray(library) && library.includes("dynamic");
    })
    .map((product) => ({ module: product.name, name: addonName(product.name) }));

  if (targets.length === 0) {
    throw new Error(
      `[chord-native] ${manifestPath(root)} declares no dynamic library products; ` +
        `a NodeSwift addon must be declared as ` +
        `.library(name: "…", type: .dynamic, targets: ["…"])`,
    );
  }
  assertUniqueAddonNames(root, targets);
  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Addon filename stem for a Swift module. The module name is namespaced to stay globally unique
 * (see the file header); the addon Chord loads keeps the short trailing name, so
 * `KeychordChordsMenuNativeMenu` is written as `menu.node`.
 */
export function addonName(module: string): string {
  const match = /Native([A-Z][A-Za-z0-9]*)$/.exec(module);
  const stem = match ? match[1]! : module;
  return stem[0]!.toLowerCase() + stem.slice(1);
}

function assertUniqueAddonNames(root: string, targets: NativeTarget[]) {
  const seen = new Map<string, string>();
  for (const target of targets) {
    const existing = seen.get(target.name);
    if (existing) {
      throw new Error(
        `[chord-native] ${manifestPath(root)}: products ${existing} and ${target.module} both ` +
          `produce ${target.name}.${NATIVE_MODULE_EXTENSION}; give them distinct names`,
      );
    }
    seen.set(target.name, target.module);
  }
}

function installedNodeSwiftVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return JSON.parse(fs.readFileSync(require.resolve("node-swift/package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * The manifest pins node-swift by version while npm installs its own copy; nothing structural
 * keeps the two in step, so compare them and fail loudly rather than build against a bridge that
 * does not match the JS side.
 */
function assertNodeSwiftVersionMatches(root: string, dumped: DumpedPackage) {
  const installed = installedNodeSwiftVersion();
  if (!installed) return;

  for (const dependency of dumped.dependencies) {
    for (const source of dependency.sourceControl ?? []) {
      if (source.identity !== NODE_SWIFT_PACKAGE_IDENTITY) continue;
      const requirement = source.requirement ?? {};
      const pinned = (requirement as any).exact?.[0];
      if (pinned === undefined) {
        // A range or branch requirement cannot be compared to a single installed version.
        return;
      }
      if (pinned !== installed) {
        throw new Error(
          `[chord-native] ${manifestPath(root)} pins node-swift ${pinned} but the installed ` +
            `npm node-swift is ${installed}. Update the manifest (or package.json) so both ` +
            `sides use the same bridge, or set allowNodeSwiftVersionMismatch to override.`,
        );
      }
      return;
    }
  }
}

/**
 * Map a Rust-style triple to the Swift one SwiftPM expects. The macOS version is deliberately
 * omitted: the manifest's `platforms:` is the single source of truth for the deployment target,
 * and repeating it here would let the two disagree.
 */
function swiftTargetTriple(triple: string): string {
  const [rawArch, vendor] = triple.split("-");
  if (vendor !== "apple") {
    throw new Error(
      `[chord-native] unsupported target triple ${triple} (only Apple triples are supported)`,
    );
  }
  const arch = rawArch === "aarch64" ? "arm64" : rawArch;
  if (arch !== "arm64" && arch !== "x86_64") {
    throw new Error(`[chord-native] unsupported architecture in ${triple}`);
  }
  return `${arch}-apple-macosx`;
}

function outputDirForTarget(root: string, targetDir: string, triple: string, name: string): string {
  return path.join(root, targetDir, triple, name);
}

export type BuildNativeResult = {
  target: string;
  triple: string;
  module: string;
  outputDir: string;
}[];

export type BuildNativeContext = {
  packageName?: string;
  /** Retained so callers can pass their config context; vendoring happens during `vp pack`. */
  vendor?: string[];
};

/**
 * Build every dynamic library product declared in the package manifest, for every requested
 * target triple.
 *
 * This always builds. Deciding *whether* a build is necessary is the caller's concern -- use a
 * task runner (moon, make, ...) that hashes `Package.swift` and `Sources/**` as inputs and
 * `targetDir` as outputs.
 */
export async function buildNative(
  root: string,
  options: NativeOptions = {},
  _context: BuildNativeContext = {},
): Promise<BuildNativeResult> {
  if (!hasNativeManifest(root)) return [];

  const dumped = dumpPackage(root);
  if (!options.allowNodeSwiftVersionMismatch) assertNodeSwiftVersionMatches(root, dumped);

  const targets = discoverNativeTargets(root);
  const targetDir = options.targetDir ?? NATIVE_TARGET_DIR;
  const triples = options.triples?.length ? options.triples : [hostTriple()];
  const mode = options.optimize === false ? "debug" : "release";
  const scratchDir = path.resolve(root, options.scratchDir ?? "node_modules/.cache/chord/native");
  const results: BuildNativeResult = [];

  for (const triple of triples) {
    const targetTriple = swiftTargetTriple(triple);

    for (const target of targets) {
      const outDir = outputDirForTarget(root, targetDir, triple, target.name);
      const buildDir = path.join(scratchDir, triple, target.name);

      console.log(`[chord-native] building ${target.module} as ${target.name} for ${triple}`);

      // SwiftPM builds the authored package directly and keeps incremental products in
      // buildPath, without generating a package or staging a copy of the Swift sources.
      const builtAddon = await buildNodeSwift(mode, {
        buildPath: path.join(buildDir, "build", targetTriple, mode),
        packagePath: root,
        product: target.module,
        napi: NODE_API_VERSION,
        static: false,
        builder: { type: "swiftpm", triple: targetTriple },
      });

      const staged = path.join(buildDir, "out");
      const builtRuntime = path.join(path.dirname(builtAddon), NODE_SWIFT_RUNTIME_FILENAME);
      if (!fs.existsSync(builtRuntime)) {
        throw new Error(
          `[chord-native] NodeSwift did not produce ${NODE_SWIFT_RUNTIME_FILENAME} beside ${builtAddon}`,
        );
      }
      fs.rmSync(staged, { recursive: true, force: true });
      fs.mkdirSync(staged, { recursive: true });
      fs.copyFileSync(builtAddon, path.join(staged, `${target.name}.${NATIVE_MODULE_EXTENSION}`));
      fs.copyFileSync(builtRuntime, path.join(staged, NODE_SWIFT_RUNTIME_FILENAME));
      const accessibilityRuntime = "libAXorcistRuntime.dylib";
      const builtAccessibility = path.join(path.dirname(builtAddon), accessibilityRuntime);
      if (fs.existsSync(builtAccessibility)) {
        fs.copyFileSync(builtAccessibility, path.join(staged, accessibilityRuntime));
        fs.chmodSync(path.join(staged, accessibilityRuntime), 0o755);
      }
      fs.chmodSync(path.join(staged, `${target.name}.${NATIVE_MODULE_EXTENSION}`), 0o755);
      fs.chmodSync(path.join(staged, NODE_SWIFT_RUNTIME_FILENAME), 0o755);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(outDir), { recursive: true });
      fs.cpSync(staged, outDir, { recursive: true });

      results.push({ target: target.name, triple, module: target.module, outputDir: outDir });
    }
  }

  console.log(
    `[chord-native] built ${results.length} addon(s) -> ${targetDir}/{${triples.join(",")}}/`,
  );
  return results;
}
