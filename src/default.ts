import path from "path";
import fs from "fs";
import type { UserConfig } from "vite-plus";

export type Options = {
  vendor?: string[];
  dts?: boolean;
  plugins?: any[]
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

  return {
    plugins: options?.plugins,
    pack: [
      {
        entry: {
          'package.json': 'package.json',
        },
        copy: options?.vendor?.flatMap(packageName => {
          return [
            { from: `node_modules/${packageName}/js`, to: `js/${packageName}` },
            { from: `node_modules/${packageName}/chords`, to: `chords/${packageName}` }
          ]
        }),
        outDir: 'js',
        fixedExtension: false,
      },
      ...Object.values(entry).map(entry => ({
        entry,
        clean: false,
        outDir: 'js',
        dts: options?.dts,
        fixedExtension: false,
        deps: {
          // This is needed to remove the warning from console output, but tsdown types don't like for some reason so we cast it to never
          onlyBundle: false as never,
          alwaysBundle: [/.*/],
          neverBundle: ["chord", ...(options?.vendor ?? [])],
        },
      }))
    ] satisfies UserConfig["pack"],
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
