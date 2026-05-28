import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function copyLiteparseWasm(): Plugin {
  return {
    name: "copy-liteparse-wasm",
    apply: "build",
    closeBundle() {
      const src = path.resolve(
        __dirname,
        "node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm",
      );
      const dst = path.resolve(__dirname, "dist/liteparse.wasm");
      fs.copyFileSync(src, dst);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest }), copyLiteparseWasm()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
  },
});
