// src/lib/extraction/serialize.test.ts
import { describe, it, expect } from "vitest";
import { toCSV } from "./serialize";
import type { ExtractionField, ExtractionRow } from "./types";

const schema: ExtractionField[] = [
  { name: "title", type: "string" },
  { name: "price", type: "number" },
];
const rows: ExtractionRow[] = [
  { title: "A, B", price: 12.5, _source: { page: 1, url: "https://x/p1" } },
  { title: 'He said "hi"', price: 3, _source: { page: 2, url: "https://x/p2" } },
];

describe("toCSV", () => {
  it("含来源列(默认)+ 正确转义", () => {
    const csv = toCSV(rows, schema, { includeSourceColumns: true });
    const lines = csv.split("\n");
    expect(lines[0]).toBe('title,price,_source_page,_source_url');
    expect(lines[1]).toBe('"A, B",12.5,1,https://x/p1');
    expect(lines[2]).toBe('"He said ""hi""",3,2,https://x/p2');
  });
  it("可关掉来源列", () => {
    const csv = toCSV(rows, schema, { includeSourceColumns: false });
    expect(csv.split("\n")[0]).toBe("title,price");
  });
  it("空 rows 仅表头", () => {
    expect(toCSV([], schema, { includeSourceColumns: true })).toBe("title,price,_source_page,_source_url");
  });
});
