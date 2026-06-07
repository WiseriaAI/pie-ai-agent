import { describe, it, expect } from "vitest";
import { buildOutputExtractionTool } from "./extraction-output";

const schema = [{ name: "title", type: "string" }, { name: "price", type: "number" }];
const rows = [{ title: "A", price: 1, _source: { page: 1, url: "https://x/p1" } }];

describe("output_extraction", () => {
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

  it("缺 rows 报错", async () => {
    const tool = buildOutputExtractionTool({ sessionId: "s1", store: () => {} });
    const r = await tool.handler({ format: "csv", schema } as any, {} as any);
    expect(r.success).toBe(false);
  });
});
