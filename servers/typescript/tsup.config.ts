import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "node-stdio":  "src/entrypoints/node-stdio.ts",
    "node-http":   "src/entrypoints/node-http.ts",
    "browser-ext": "src/entrypoints/browser-ext.ts",
  },
  format: ["esm", "cjs"],
  target: "node18.17",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
});
