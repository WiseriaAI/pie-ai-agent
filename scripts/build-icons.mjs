#!/usr/bin/env node
// Rasterize public/icons/icon-128.svg to PNG at 16/32/48/128.
// Chrome MV3 manifest does not reliably support SVG in chrome://extensions
// or the toolbar — PNG is the only safe icon format. This script is the
// single source of truth: edit icon-128.svg, run pnpm icons (or pnpm build),
// PNGs regenerate from the same vector.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const svgPath = resolve(repoRoot, "public/icons/icon-128.svg");
const svg = readFileSync(svgPath);

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0, 0, 0, 0)",
  });
  const png = resvg.render().asPng();
  const outPath = resolve(repoRoot, `public/icons/icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`  wrote ${outPath} (${png.length} bytes)`);
}
