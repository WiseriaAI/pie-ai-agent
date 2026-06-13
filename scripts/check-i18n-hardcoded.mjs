import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["diff", "--name-only", "--cached"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => file.startsWith("src/sidepanel/"))
  .filter((file) => /\.(tsx|ts)$/.test(file))
  .filter((file) => !file.endsWith(".test.tsx"))
  .filter((file) => !file.includes("/__tests__/"));

const allow = [
  "className",
  "data-testid",
  "data-",
  "aria-",
  "role",
  "type",
  "viewBox",
  "fill",
  "stroke",
  "M",
  "http",
  "https",
];

let failed = false;

for (const file of files) {
  const content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8" });
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    const hasString = /["'`][A-Za-z][^"'`]{2,}["'`]/.test(line);
    const usesT = line.includes("t(");
    const allowed = allow.some((token) => line.includes(token));

    if (hasString && !usesT && !allowed) {
      failed = true;
      console.error(`${file}:${index + 1}: possible visible hardcoded string`);
      console.error(line);
    }
  });
}

if (failed) {
  process.exit(1);
}
