import path from 'path'
import fs from 'fs'
import virtual from 'vite-plugin-virtual';
import { fileURLToPath } from 'url';

export type Options = {
  vendor?: string[];
  dts?: boolean;
};

// Needs to be named `config` or else vite-plus thinks it's its `defineConfig`
export function config(options?: Options) {
  const srcJsDirpath = path.join(process.cwd(), 'src/js');
  let entry: string | Record<string, string> = {};

  if (fs.existsSync(srcJsDirpath) && fs.statSync(srcJsDirpath).isDirectory()) {
    for (const filename of fs.readdirSync(srcJsDirpath).filter((file) => file.endsWith(".ts"))) {
      entry[path.parse(filename).name] = path.join(srcJsDirpath, filename);
    }
  }

  if (Object.keys(entry).length === 0) {
    entry['noop'] = "virtual:empty";
  }

  const specifier = fileURLToPath(import.meta.resolve('@keychord/eslint-plugin-package-json'))
  const eslintBinPath = path.join(fileURLToPath(import.meta.resolve('eslint/package.json')), '../bin/eslint.js');

  return {
    plugins: [
      virtual({
        'virtual:empty': '',
      }),
    ] as any[],
    pack: {
      entry,
      outDir: "js",
      deps: {
        neverBundle: [
          "chord",
          ...(options?.vendor ?? [])
        ]
      },
    },
    run: {
      tasks: {
        fix: {
          // Sadly, oxlint does not support fixing JSON files (see https://oxc.rs/compatibility.html), and oxfmt does not (yet) support plugins, so we fall back to using ESLint
          command: `
            ${eslintBinPath} **/package.json \
              --no-config-lookup \
              --fix \
              --plugin ${specifier} \
              --rule '@keychord/package-json/type: error'
          `,
        }
      }
    },
    // lint: {
    // }
  }
}
