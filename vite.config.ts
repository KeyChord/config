import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: 'src/default.ts',
    dts: true,
    outDir: 'exports',
    exports: {
      devExports: true
    }
  },
});
