import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import type { Plugin } from "vite-plus";

export type PackageChordsPluginOptions = {
  /** Package containing `package.json` and the `chords/` directory. */
  root?: string;
  /** Vendored chord packages, whose `chords/` trees are copied into this package's `chords/`. */
  vendor?: string[];
};

/** A `chords/` directory: folders become nested objects, `.toml` files their parsed contents. */
export type ChordsTree = { [name: string]: ChordsTree | Record<string, unknown> };

const CHORDS_DIR = "chords";

/** Add a `chords` property with the package's parsed `chords/` tree to its bundled `package.json`. */
export function packageChordsPlugin(options: PackageChordsPluginOptions = {}): Plugin {
  // Bundlers canonicalize module filenames (notably /var -> /private/var on macOS).
  const root = fs.realpathSync(options.root ?? process.cwd());
  const packageJsonPath = path.join(root, "package.json");

  return {
    name: "keychord-package-chords",
    load(id) {
      if (id !== packageJsonPath) return null;
      const files = new Map<string, string>();
      collectTomlFiles(path.join(root, CHORDS_DIR), [], files);
      // tsdown copies vendored chords only after bundling, so read them from their source to
      // describe the `chords/` tree this build leaves behind rather than the previous one.
      for (const packageName of options.vendor ?? []) {
        collectTomlFiles(
          path.join(root, "node_modules", packageName, CHORDS_DIR),
          [...packageName.split("/"), CHORDS_DIR],
          files,
        );
      }

      const chords: ChordsTree = {};
      // Sorted so the emitted key order doesn't depend on the filesystem's listing order.
      for (const relative of [...files.keys()].sort()) {
        const file = files.get(relative)!;
        this.addWatchFile(file);
        let data: Record<string, unknown>;
        try {
          data = parse(fs.readFileSync(file, "utf8"));
        } catch (error) {
          this.error(`[chord-package] failed to parse ${file}: ${(error as Error).message}`);
        }
        // Each vendored package keeps its own root chords/macos.toml.
        const vendor = options.vendor?.find((name) => relative.startsWith(`${name}/chords/`));
        const packageRelative = (
          vendor ? relative.slice(`${vendor}/chords/`.length) : relative
        ).replace(/^(?:@[^/]+\/[^/]+\/chords\/)+/, "");
        if (packageRelative !== "macos.toml") {
          for (const key of Object.keys(data.chords ?? {})) {
            if (isGlobalBinding(key)) {
              this.error(
                `[chord-package] global chord ${JSON.stringify(key)} in ${file} must be defined in the package's root chords/macos.toml`,
              );
            }
          }
        }
        const segments = relative.split("/");
        let directory = chords;
        for (const segment of segments.slice(0, -1)) {
          directory = (directory[segment] ??= {}) as ChordsTree;
        }
        directory[segments[segments.length - 1]!] = data;
      }

      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      return { code: JSON.stringify({ ...packageJson, chords }), moduleType: "json" };
    },
  };
}

function isGlobalBinding(key: string): boolean {
  const hint = key.startsWith("?");
  const sequence = hint ? key.slice(1) : key;
  // An initial quoted or parenthesized hint range represents letters/digits, not a symbol.
  if (hint && /^(?:"[a-z0-9]-[a-z0-9]"|\([a-z0-9]-[a-z0-9]\))$/.test(sequence)) return false;
  return /^[^\p{L}\p{N}]/u.test(sequence);
}

/** Map each `.toml` file under `directory` from its `/`-joined path within `chords/`. */
function collectTomlFiles(directory: string, prefix: string[], files: Map<string, string>) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(".")) continue;
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) {
      collectTomlFiles(file, [...prefix, name], files);
    } else if (name.endsWith(".toml")) {
      files.set([...prefix, name].join("/"), file);
    }
  }
}
