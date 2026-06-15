#!/usr/bin/env node
// Rasterize the source SVGs in public/icons to PNG at 16/32/48/128.
// Chrome MV3 manifest does not reliably support SVG in chrome://extensions
// or the toolbar — PNG is the only safe icon format. This script is the
// single source of truth: edit the source <name>.svg, run pnpm icons
// (or pnpm build), and the PNGs regenerate from the same vector.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Each entry: a source SVG and the PNG basename it rasterizes to.
//   icon         → the extension app/toolbar icon (manifest references these)
//   managed-plan → standalone "official subscription" plan mark (gradient sparkle)
//   mesh-sparkle → just the sparkle, reusable "premium / paid" marker
const icons = [
  { src: "public/icons/icon-128.svg", out: "public/icons/icon" },
  { src: "public/icons/managed-plan.svg", out: "public/icons/managed-plan" },
  { src: "public/icons/mesh-sparkle.svg", out: "public/icons/mesh-sparkle" },
];

const sizes = [16, 32, 48, 128];

for (const { src, out } of icons) {
  const svg = readFileSync(resolve(repoRoot, src));
  for (const size of sizes) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: size },
      background: "rgba(0, 0, 0, 0)",
    });
    const png = resvg.render().asPng();
    const outPath = resolve(repoRoot, `${out}-${size}.png`);
    writeFileSync(outPath, png);
    console.log(`  wrote ${outPath} (${png.length} bytes)`);
  }
}
