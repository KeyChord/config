import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      entry: "src/default.ts",
      dts: true,
      outDir: "exports",
      exports: {
        // The package manager used to ignore publishConfig.exports and publish the development
        // TypeScript entry. Always make the primary export point at built JavaScript instead.
        devExports: false,
        customExports(exports) {
          const root = exports["."];
          return {
            ...exports,
            ".": {
              types: "./exports/default.d.mts",
              ...(typeof root === "string" ? { default: root } : root),
            },
          };
        },
      },
      deps: {
        neverBundle: ["node-swift"],
      },
    },
    {
      // The `compile` task / `keychord-compile` bin, bundled so published installs don't need
      // the TypeScript source. `native.ts` is bundled in; keep the shebang.
      entry: "src/compile.ts",
      outDir: "exports",
      dts: false,
      fixedExtension: false,
      deps: {
        neverBundle: ["node-swift"],
      },
    },
  ],
});
