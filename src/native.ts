/**
 * NodeSwift addon builds for Chord packages.
 *
 * Source layout:
 *   src/swift/<path>/<name>.swift   one addon per module directory
 *   src/swift/_shared/**            compiled into every addon
 *   src/swift/<path>/**             extra Swift sources for that addon
 *
 * Output mirrors the module path for each target triple:
 *   target/<triple>/<path>/<name>.node
 *
 * A temporary SwiftPM package is generated under `.chord-native-build/`. NodeSwift supplies the
 * Node-API bridge and produces a `.node` file plus its shared `libNodeAPI.dylib` runtime. Keeping
 * NodeAPI dynamic is important when Chord loads multiple addons: statically linking it into every
 * addon registers duplicate Swift/Objective-C classes in one process.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build as buildNodeSwift } from "node-swift";

const NODE_API_VERSION = 8;
const SWIFT_DIR = "src/swift";
const NODE_SWIFT_RUNTIME_FILENAME = "libNodeAPI.dylib";

export const NATIVE_TARGET_DIR = "target";
export const NATIVE_MODULE_EXTENSION = "node";

export type NativeTargetOptions = {
  /** Frameworks not discovered through Swift's autolinking. */
  frameworks?: string[];
  /** Flags passed to Swift through NodeSwift. */
  swiftFlags?: string[];
  /** Flags passed to the linker through NodeSwift. */
  linkerFlags?: string[];
};

export type NativeOptions = {
  targets?: Record<string, NativeTargetOptions>;
  /** Rust-style target triples to build (default: the host triple). */
  triples?: string[];
  /** Release (default) or debug builds. */
  optimize?: boolean;
  /** Minimum macOS version (default "13.0"). */
  minimumMacOSVersion?: string;
  /** Swift language mode used by generated packages (default "5"). */
  languageMode?: "5" | "6";
  /** Directory holding Swift sources, relative to the package root (default "src/swift"). */
  swiftSourceDir?: string;
  /** Directory receiving built addons, relative to the package root (default "target"). */
  targetDir?: string;
  /** Scratch directory for generated SwiftPM packages (default ".chord-native-build"). */
  scratchDir?: string;
};

export type NativeTarget = {
  /** Addon/product name and output filename stem. */
  name: string;
  /** Path below `target/<triple>/`, e.g. `menu`. */
  outputRelpath: string;
  swiftSources: string[];
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

function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

/** A deterministic, valid Swift module name for a package addon. */
export function moduleName(packageName: string, target: string): string {
  return `${pascal(packageName)}Native${pascal(target)}`;
}

/** `src/swift/menu/menu.swift` -> `menu`. */
export function nativeOutputRelpath(
  root: string,
  swiftFile: string,
  swiftSourceDir: string = SWIFT_DIR,
): string {
  const relDir = path.relative(path.join(root, swiftSourceDir), path.dirname(swiftFile));
  return path.posix.join(...relDir.split(path.sep));
}

function isDir(value: string): boolean {
  return fs.existsSync(value) && fs.statSync(value).isDirectory();
}

function walk(dir: string, predicate: (file: string) => boolean): string[] {
  if (!isDir(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, predicate));
    else if (predicate(full)) files.push(full);
  }
  return files.sort();
}

/** Existing native source directories, used by pack/compile to decide whether to build. */
export function nativeSourceDirs(root: string, swiftSourceDir: string = SWIFT_DIR): string[] {
  const swiftDir = path.join(root, swiftSourceDir);
  return isDir(swiftDir) ? [swiftDir] : [];
}

export function discoverNativeTargets(
  root: string,
  swiftSourceDir: string = SWIFT_DIR,
): NativeTarget[] {
  const swiftDir = path.join(root, swiftSourceDir);
  if (!isDir(swiftDir)) return [];

  const shared = walk(path.join(swiftDir, "_shared"), (file) => file.endsWith(".swift"));
  const targets: NativeTarget[] = [];

  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const moduleDir = path.join(dir, entry.name);
      const entrySwift = path.join(moduleDir, `${entry.name}.swift`);
      if (fs.existsSync(entrySwift)) {
        targets.push({
          name: entry.name,
          outputRelpath: nativeOutputRelpath(root, entrySwift, swiftSourceDir),
          swiftSources: [
            entrySwift,
            ...shared,
            ...walk(
              moduleDir,
              (file) =>
                file.endsWith(".swift") &&
                file !== entrySwift &&
                !path.basename(file).startsWith("_"),
            ),
          ],
        });
      }
      visit(moduleDir);
    }
  }

  visit(swiftDir);
  return targets.sort((a, b) => a.outputRelpath.localeCompare(b.outputRelpath));
}

function nodeSwiftRoot(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve("node-swift/package.json"));
}

function swiftTargetTriple(triple: string, minimumMacOSVersion: string): string {
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
  return `${arch}-apple-macosx${minimumMacOSVersion}`;
}

function swiftString(value: string): string {
  return JSON.stringify(value);
}

type StagedTarget = { frameworks: string[] };

function generatedPackageManifest(args: {
  nodeSwiftPath: string;
  minimumMacOSVersion: string;
  languageMode: "5" | "6";
  targets: Record<string, StagedTarget>;
}): string {
  const targets = Object.entries(args.targets).sort(([a], [b]) => a.localeCompare(b));
  const products = targets
    .map(
      ([module]) =>
        `        .library(name: ${swiftString(module)}, type: .dynamic, targets: [${swiftString(module)}]),`,
    )
    .join("\n");
  const targetDeclarations = targets
    .map(([module, options]) => {
      const frameworks = options.frameworks
        .map((framework) => `                .linkedFramework(${swiftString(framework)}),`)
        .join("\n");
      const linkerSettings = frameworks
        ? `,\n            linkerSettings: [\n${frameworks}\n            ]`
        : "";
      return `        .target(
            name: ${swiftString(module)},
            dependencies: [
                .product(name: "NodeAPI", package: "node-swift"),
                .product(name: "NodeModuleSupport", package: "node-swift"),
            ]${linkerSettings}
        ),`;
    })
    .join("\n");

  return `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KeychordNativeAddons",
    platforms: [.macOS(${swiftString(args.minimumMacOSVersion)})],
    products: [
${products}
    ],
    dependencies: [
        .package(path: ${swiftString(args.nodeSwiftPath)}),
    ],
    targets: [
${targetDeclarations}
    ],
    swiftLanguageModes: [.v${args.languageMode}]
)
`;
}

function stageSwiftPackage(
  root: string,
  packageDir: string,
  module: string,
  target: NativeTarget,
  options: {
    nodeSwiftPath: string;
    minimumMacOSVersion: string;
    languageMode: "5" | "6";
    frameworks: string[];
    swiftSourceDir: string;
  },
) {
  const sourcesDir = path.join(packageDir, "Sources", module);
  fs.rmSync(sourcesDir, { recursive: true, force: true });
  fs.mkdirSync(sourcesDir, { recursive: true });

  const swiftRoot = path.join(root, options.swiftSourceDir);
  for (const source of target.swiftSources) {
    const relative = path.relative(swiftRoot, source);
    const destination = path.join(sourcesDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  const targetsFile = path.join(packageDir, ".targets.json");
  let targets: Record<string, StagedTarget> = {};
  try {
    targets = JSON.parse(fs.readFileSync(targetsFile, "utf8"));
  } catch {
    // New or invalid registry: regenerate it from this target onward.
  }
  targets[module] = { frameworks: options.frameworks };
  fs.writeFileSync(targetsFile, JSON.stringify(targets, null, 2));
  fs.writeFileSync(
    path.join(packageDir, "Package.swift"),
    generatedPackageManifest({
      nodeSwiftPath: options.nodeSwiftPath,
      minimumMacOSVersion: options.minimumMacOSVersion,
      languageMode: options.languageMode,
      targets,
    }),
  );
}

function outputDirForTarget(
  root: string,
  targetDir: string,
  triple: string,
  outputRelpath: string,
): string {
  return path.join(root, targetDir, triple, ...outputRelpath.split("/"));
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
 * Build every discovered NodeSwift addon for every requested target triple.
 *
 * This always builds. Deciding *whether* a build is necessary is the caller's
 * concern -- use a task runner (moon, make, ...) that hashes `swiftSourceDir`
 * as inputs and `targetDir` as outputs.
 */
export async function buildNative(
  root: string,
  options: NativeOptions = {},
  context: BuildNativeContext = {},
): Promise<BuildNativeResult> {
  const swiftDir = options.swiftSourceDir ?? SWIFT_DIR;
  const targetDir = options.targetDir ?? NATIVE_TARGET_DIR;
  const targets = discoverNativeTargets(root, swiftDir);
  if (targets.length === 0) return [];

  const pkgName = context.packageName ?? readPackageName(root) ?? path.basename(root);
  const triples = options.triples?.length ? options.triples : [hostTriple()];
  const minimumMacOSVersion = options.minimumMacOSVersion ?? "13.0";
  const languageMode = options.languageMode ?? "5";
  const mode = options.optimize === false ? "debug" : "release";
  const scratchDir = path.resolve(root, options.scratchDir ?? ".chord-native-build");
  const nodeSwiftPath = nodeSwiftRoot();
  const results: BuildNativeResult = [];

  for (const triple of triples) {
    const targetTriple = swiftTargetTriple(triple, minimumMacOSVersion);

    for (const target of targets) {
      const targetOptions = options.targets?.[target.name] ?? {};
      const module = moduleName(pkgName, target.name);
      const outDir = outputDirForTarget(root, targetDir, triple, target.outputRelpath);
      const buildDir = path.join(scratchDir, triple, target.outputRelpath.replaceAll("/", "__"));
      const packageDir = path.join(buildDir, "package");

      console.log(`[chord-native] building ${target.outputRelpath} as ${module} for ${triple}`);
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.mkdirSync(packageDir, { recursive: true });
      stageSwiftPackage(root, packageDir, module, target, {
        nodeSwiftPath,
        minimumMacOSVersion,
        languageMode,
        frameworks: targetOptions.frameworks ?? [],
        swiftSourceDir: swiftDir,
      });

      const builtAddon = await buildNodeSwift(mode, {
        buildPath: path.join(buildDir, "build", targetTriple, mode),
        packagePath: packageDir,
        product: module,
        napi: NODE_API_VERSION,
        static: false,
        swiftFlags: targetOptions.swiftFlags,
        linkerFlags: targetOptions.linkerFlags,
        builder: { type: "swiftpm", triple: targetTriple },
      });

      const staged = path.join(buildDir, "out");
      const builtRuntime = path.join(path.dirname(builtAddon), NODE_SWIFT_RUNTIME_FILENAME);
      if (!fs.existsSync(builtRuntime)) {
        throw new Error(
          `[chord-native] NodeSwift did not produce ${NODE_SWIFT_RUNTIME_FILENAME} beside ${builtAddon}`,
        );
      }
      fs.mkdirSync(staged, { recursive: true });
      fs.copyFileSync(builtAddon, path.join(staged, `${target.name}.${NATIVE_MODULE_EXTENSION}`));
      fs.copyFileSync(builtRuntime, path.join(staged, NODE_SWIFT_RUNTIME_FILENAME));
      fs.chmodSync(path.join(staged, `${target.name}.${NATIVE_MODULE_EXTENSION}`), 0o755);
      fs.chmodSync(path.join(staged, NODE_SWIFT_RUNTIME_FILENAME), 0o755);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(outDir), { recursive: true });
      fs.cpSync(staged, outDir, { recursive: true });

      results.push({ target: target.outputRelpath, triple, module, outputDir: outDir });
    }
  }

  console.log(
    `[chord-native] built ${results.length} addon(s) -> ${targetDir}/{${triples.join(",")}}/`,
  );
  return results;
}

function readPackageName(root: string): string | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}
