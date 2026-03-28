import type { Plugin, UserConfig } from 'vite-plus'
import path from 'path'
import fs from 'fs'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import virtual from 'vite-plugin-virtual';
import dts from 'vite-plugin-dts';

export type Options = {
  vendor?: string[];
  dts?: boolean;
};

export default function defineConfig(options: Options): UserConfig {
  const plugins: any[] = [
    virtual({
      'virtual:empty': '',
    }),
    options?.dts && dts(),
    {
      name: "keychord",
      config(config) {
        const root = config.root ?? process.cwd();
        const srcJsDirpath = path.join(root, 'src/js');
        let input: string | Record<string, string> = {};

        if (fs.existsSync(srcJsDirpath) && fs.statSync(srcJsDirpath).isDirectory()) {
          for (const filename of fs.readdirSync(srcJsDirpath).filter((file) => file.endsWith(".ts"))) {
            input[path.parse(filename).name] = path.join(srcJsDirpath, filename);
          }
        }

        if (Object.keys(input).length === 0) {
          input['noop'] = "virtual:empty";
        }

        return {
          build: {
            // Since we target a "server" runtime (LLRT)
            ssr: true,
            emptyOutDir: false,
            outDir: "js",

            rolldownOptions: {
              input,

              // We need to produce self-contained files
              external: ["chord", ...(options?.vendor ?? [])],
            },
          },
          ssr: {
            noExternal: true,
          },
        };
      },
    } satisfies Plugin
  ]

  if (options?.vendor?.length) {
    plugins.push(
      viteStaticCopy({
        /** @see https://github.com/sapphi-red/vite-plugin-static-copy/issues/216 */
        environment: "ssr",
        targets: options.vendor?.map((packageName) => ({
          src: `node_modules/${packageName}/js`,
          dest: ".",
          rename: { stripBase: 1 },
        })),
      })
    );
  }

  return {
    plugins,
    lint: {
      jsPlugins: ['@keychord/eslint-plugin-package-json'],
      overrides: [
        {
          files: ['**/package.json'],
          rules: {
            'keychord/proper-package-json': 'error'
          }
        }
      ]
    }
  }
}
