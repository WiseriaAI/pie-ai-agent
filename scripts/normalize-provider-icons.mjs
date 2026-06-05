/**
 * Normalize provider-icon svgs so they render at a consistent visual size.
 *
 * Source iconfont svgs share a `0 0 1024 1024` viewBox but their actual logo
 * path occupies wildly different fractions of it (anthropic ~90%, stepfun ~69%,
 * zhipu is tall, …). When rendered with object-fit/mask `contain`, that internal
 * padding leaks through and the icons look uneven.
 *
 * This tool measures each path's real bounding box (via a headless browser's
 * getBBox) and rewrites the viewBox to a square centered on that bbox, with the
 * content occupying `PAD` of the box. Idempotent: path coordinates never change,
 * so re-running produces the same viewBox.
 *
 * Usage (from repo root):
 *   node scripts/normalize-provider-icons.mjs
 *
 * Run it after dropping a new `public/provider-icons/<id>.svg` (with
 * `fill="currentColor"`). Requires the `playwright` dev dependency.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const dir = "public/provider-icons";
const PAD = 0.86; // logo content occupies 86% of the square box (7% margin each side)

const browser = await chromium.launch();
const page = await browser.newPage();
for (const f of readdirSync(dir).filter((x) => x.endsWith(".svg"))) {
  const svg = readFileSync(`${dir}/${f}`, "utf8");
  await page.setContent(`<!doctype html><body>${svg}</body>`);
  const b = await page.evaluate(() => {
    const e = document.querySelector("svg");
    const x = e.getBBox();
    return { x: x.x, y: x.y, w: x.width, h: x.height };
  });
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const side = Math.max(b.w, b.h) / PAD;
  const vb = `${(cx - side / 2).toFixed(2)} ${(cy - side / 2).toFixed(2)} ${side.toFixed(2)} ${side.toFixed(2)}`;
  const next = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  if (next !== svg) writeFileSync(`${dir}/${f}`, next);
  console.log(f, "->", vb);
}
await browser.close();
