import { defineConfig } from "vite-plus";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [dts()],
  build: {
    ssr: true,
    outDir: "exports",
    lib: {
      entry: "src/default.ts",
      fileName: "default",
      formats: ["es"],
    },
  },
});
