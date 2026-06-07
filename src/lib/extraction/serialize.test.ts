// src/lib/extraction/serialize.test.ts
import { describe, it, expect } from "vitest";
import { toCSV, toContractJSON } from "./serialize";
import type { ExtractionField, ExtractionRow, ExtractionResult } from "./types";

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

describe("toContractJSON", () => {
  it("产出完整契约 {schema, rows, meta}", () => {
    const result: ExtractionResult = {
      schema,
      rows,
      meta: { extractedAt: "2026-06-07T00:00:00Z", rowCount: 2, pageCount: 2, producedBy: { skillId: "s1", skillName: "N", version: 1 } },
    };
    const parsed = JSON.parse(toContractJSON(result));
    expect(parsed.rows[0]._source).toEqual({ page: 1, url: "https://x/p1" });
    expect(parsed.meta.rowCount).toBe(2);
    expect(parsed.schema[0].name).toBe("title");
  });
});
