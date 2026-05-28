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
    buildStart() {
      // Copy to public/ so @crxjs/vite-plugin can resolve it in web_accessible_resources
      // and it gets emitted to dist/ automatically by Vite's asset pipeline.
      const src = path.resolve(
        __dirname,
        "node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm_bg.wasm",
      );
      const dst = path.resolve(__dirname, "public/liteparse.wasm");
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
    rollupOptions: {
      // Offscreen documents are not declared in manifest.json (only via
      // chrome.offscreen.createDocument), so @crxjs/vite-plugin does not
      // auto-discover them. Adding the HTML as a Rollup input causes Vite
      // to bundle the inline `<script type="module" src="./pdf-parser.ts">`
      // into a real JS module and rewrite the HTML to point at it.
      input: {
        "offscreen-pdf-parser": path.resolve(__dirname, "src/offscreen/pdf-parser.html"),
      },
    },
  },
});
