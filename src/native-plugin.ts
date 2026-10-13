import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { hostTriple, NATIVE_TARGET_DIR, type NativeOptions } from "./native.ts";

export type NativeAddonPluginOptions = Pick<NativeOptions, "triples" | "targetDir"> & {
  /** Package containing the SwiftPM manifest and prebuilt target tree. */
  root?: string;
};

const PREFIX = "\0keychord-native:";
const RUNTIME_FILENAME = "libNodeAPI.dylib";
const RUNTIME_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
};

/** Resolve require("./menu.node") and package each selected NodeSwift addon with its runtime. */
export function nativeAddonPlugin(options: NativeAddonPluginOptions = {}): Plugin {
  // Bundlers canonicalize module filenames (notably /var -> /private/var on macOS).
  const root = fs.realpathSync(options.root ?? process.cwd());
  const targetDir = path.resolve(root, options.targetDir ?? NATIVE_TARGET_DIR);
  const triples = [...new Set(options.triples?.length ? options.triples : [hostTriple()])];

  return {
    name: "keychord-native-addons",
    resolveId(source, importer) {
      const match = /^\.\/([A-Za-z][A-Za-z0-9_-]*)\.node$/.exec(source);
      if (!match || !importer || importer.startsWith("\0")) return null;
      const relative = path.relative(root, importer);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      // A real relative file keeps its normal resolution; this convention supplies missing
      // source-side filenames from the package's native build output.
      if (fs.existsSync(path.resolve(path.dirname(importer), source))) return null;
      return `${PREFIX}${match[1]}`;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const name = id.slice(PREFIX.length);
      const urls: string[] = [];
      for (const triple of triples) {
        const runtimeTarget = RUNTIME_TARGETS[triple];
        if (!runtimeTarget) this.error(`[chord-native] unsupported addon target triple ${triple}`);
        const directory = path.join(targetDir, triple, name);
        const binary = path.join(directory, `${name}.node`);
        const runtime = path.join(directory, RUNTIME_FILENAME);
        for (const file of [binary, runtime]) {
          if (!fs.existsSync(file)) {
            this.error(`[chord-native] missing ${file}; build the package's native addons first`);
          }
          this.addWatchFile(file);
        }
        const content = fs.readFileSync(binary);
        const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
        // The dynamic linker needs the runtime's original name beside the addon. Separate
        // target/module directories also prevent different runtimes from overwriting each other.
        const outputDirectory = `native/${triple}/${name}`;
        const reference = this.emitFile({
          type: "asset",
          fileName: `${outputDirectory}/${name}-${hash}.node`,
          source: content,
        });
        this.emitFile({
          type: "asset",
          fileName: `${outputDirectory}/${RUNTIME_FILENAME}`,
          source: fs.readFileSync(runtime),
        });
        urls.push(`${JSON.stringify(runtimeTarget)}: import.meta.ROLLUP_FILE_URL_${reference}`);
      }

      // A CommonJS export preserves require()'s return value, and supports default imports too.
      // File references are made relative to the emitted JS chunk by the bundler, so moving or
      // vendoring the whole js/ directory never depends on the original build path.
      return {
        moduleType: "js",
        code: `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const nativeRequire = createRequire(import.meta.url);
const nativeFiles = { ${urls.join(", ")} };
const nativeTarget = process.platform + "-" + process.arch;
const nativeFile = nativeFiles[nativeTarget];
if (!nativeFile) throw new Error(${JSON.stringify(`[chord-native] ${name} has no addon for `)} + nativeTarget);
module.exports = nativeRequire(fileURLToPath(nativeFile));
`,
      };
    },
  };
}
