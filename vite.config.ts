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

function copySqlWasm(): Plugin {
  return {
    name: "copy-sql-wasm",
    apply: "build",
    buildStart() {
      const src = path.resolve(__dirname, "node_modules/sql.js/dist/sql-wasm.wasm");
      const dst = path.resolve(__dirname, "public/sql-wasm.wasm");
      fs.copyFileSync(src, dst);
    },
  };
}

export default defineConfig(({ mode }) => {
  const isEval = mode === "eval";
  return {
    plugins: [react(), tailwindcss(), crx({ manifest }), copyLiteparseWasm(), copySqlWasm()],
    define: {
      __PIE_EVAL__: JSON.stringify(isEval),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    build: {
      outDir: isEval ? "dist-eval" : "dist",
      // 关掉 <link rel="modulepreload"> 注入。Chrome 会对每个共享 chunk 报
      //   "A preload for … is found, but is not used because it is a
      //    cross-world extension resource mismatch"
      // 并把它记进扩展的 Errors 面板:同一个 chunk 同时被 sidepanel（特权扩展
      // 页面）和 src/offscreen/pdf-parser.html（列在 web_accessible_resources
      // 里，因而属于网页可见的另一个 world）引用，两个 world 的缓存条目不通用，
      // 于是 preload 拿到的那份永远用不上。
      //
      // preload 纯粹是加载优化，而扩展的资源都在本地、没有网络往返，收益本就
      // 接近于零 —— 模块照常在 import 时加载，功能完全不受影响。
      //
      // 另一条路是把 pdf-parser.html 移出 web_accessible_resources（offscreen
      // 用 chrome.offscreen.createDocument + runtime.getURL，本就不需要它），
      // 但那是在动安全边界，得先真机验过 PDF 与 scratchpad 才敢改。
      modulePreload: false,
      rollupOptions: {
        input: {
          "offscreen-pdf-parser": path.resolve(__dirname, "src/offscreen/pdf-parser.html"),
        },
      },
    },
  };
});
