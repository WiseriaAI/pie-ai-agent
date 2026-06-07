import { describe, it, expect, beforeEach } from "vitest";
import { buildOutputExtractionTool, buildAddExtractionRowsTool } from "./extraction-output";
import { clearAccumulated } from "@/lib/extraction/accumulator";

const schema = [{ name: "title", type: "string" }, { name: "price", type: "number" }];
const rows = [{ title: "A", price: 1, _source: { page: 1, url: "https://x/p1" } }];

describe("output_extraction (inline rows)", () => {
  beforeEach(() => clearAccumulated("s1"));

  it("format=csv 存 csv 产物 + 返回 fileOutput 卡片", async () => {
    const stored: any[] = [];
    const tool = buildOutputExtractionTool({ sessionId: "s1", store: (a) => { stored.push(a); } });
    const r = await tool.handler(
      { format: "csv", filename: "orders", schema, rows, pageCount: 1, producedBy: { skillId: "k", skillName: "Orders", version: 1 } },
      {} as any,
    );
    expect(r.success).toBe(true);
    expect(stored[0].mime).toBe("text/csv");
    expect(stored[0].content).toContain("title,price,_source_page,_source_url");
    expect(r.fileOutput?.filename).toContain("orders");
  });

  it("format=json 存契约 JSON,meta.rowCount 由工具算", async () => {
    const stored: any[] = [];
    const tool = buildOutputExtractionTool({ sessionId: "s1", store: (a) => { stored.push(a); } });
    const r = await tool.handler(
      { format: "json", filename: "orders", schema, rows, pageCount: 1, producedBy: { skillId: "k", skillName: "Orders", version: 1 } },
      {} as any,
    );
    const parsed = JSON.parse(stored[0].content);
    expect(stored[0].mime).toBe("application/json");
    expect(parsed.meta.rowCount).toBe(1);
    expect(parsed.rows[0]._source.page).toBe(1);
  });

  it("无 inline rows 且缓冲为空 → 报错(引导先 add_extraction_rows)", async () => {
    const tool = buildOutputExtractionTool({ sessionId: "s1", store: () => {} });
    const r = await tool.handler({ format: "csv", schema } as any, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toContain("add_extraction_rows");
  });

  it("format 缺失 → 报错", async () => {
    const tool = buildOutputExtractionTool({ sessionId: "s1", store: () => {} });
    const r = await tool.handler({} as any, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toContain("format");
  });
});

describe("add_extraction_rows + output_extraction(走缓冲,output 不传 rows)", () => {
  beforeEach(() => clearAccumulated("s1"));

  it("逐页 add 后 output_extraction 序列化缓冲(output 只传 format)", async () => {
    const add = buildAddExtractionRowsTool({ sessionId: "s1" });
    const r1 = await add.handler(
      { rows: [{ title: "A", price: 1, _source: { page: 1, url: "u1" } }], schema, reset: true },
      {} as any,
    );
    expect(r1.success).toBe(true);
    await add.handler({ rows: [{ title: "B", price: 2, _source: { page: 2, url: "u2" } }] }, {} as any);

    const stored: any[] = [];
    const out = buildOutputExtractionTool({ sessionId: "s1", store: (a) => { stored.push(a); } });
    const r = await out.handler({ format: "json", filename: "orders", pageCount: 2 }, {} as any); // 不传 rows/schema
    expect(r.success).toBe(true);
    const parsed = JSON.parse(stored[0].content);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[1]._source.page).toBe(2);
    expect(parsed.schema[0].name).toBe("title");
    expect(parsed.meta.rowCount).toBe(2);
  });

  it("add_extraction_rows 缺 rows → 报错", async () => {
    const add = buildAddExtractionRowsTool({ sessionId: "s1" });
    const r = await add.handler({} as any, {} as any);
    expect(r.success).toBe(false);
  });
});
