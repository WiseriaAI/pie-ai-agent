import { describe, it, expect, beforeEach } from "vitest";
import { probePageInjected } from "./probe-core";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("atlas targets carry extract signatures", () => {
  it("table target: kind=table + ordinal + columnsKey from headers", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>Name</th><th>Price</th></tr></thead>
      <tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr><tr><td>C</td><td>3</td></tr></tbody></table>`;
    const r = probePageInjected({ op: "atlas" });
    if (r.op !== "atlas") throw new Error("narrow");
    const table = r.targets.find((t) => t.type === "table");
    expect(table?.signature).toEqual({ kind: "table", ordinal: 0, columnsKey: "NamePrice" });
  });

  it("collection target: kind=collection + itemShapeKey stable across probes", () => {
    document.body.innerHTML = `
      <ul>
        <li><h3><a href="/a">A</a></h3><span class="price">¥1</span></li>
        <li><h3><a href="/b">B</a></h3><span class="price">¥2</span></li>
        <li><h3><a href="/c">C</a></h3><span class="price">¥3</span></li>
      </ul>`;
    const r1 = probePageInjected({ op: "atlas" });
    const r2 = probePageInjected({ op: "atlas" });
    if (r1.op !== "atlas" || r2.op !== "atlas") throw new Error("narrow");
    const c1 = r1.targets.find((t) => t.type === "collection");
    const c2 = r2.targets.find((t) => t.type === "collection");
    expect(c1?.signature?.kind).toBe("collection");
    expect(c1?.signature).toEqual(c2?.signature); // same DOM → same signature
  });
});

describe("probePageInjected op=extract (table)", () => {
  const LONG = "x".repeat(300); // exceeds atlas 120-char truncation → verifies full fidelity

  it("extracts all rows full-fidelity with column-named slots", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>Name</th><th>Desc</th></tr></thead><tbody>
        ${Array.from({ length: 40 }, (_, i) => `<tr><td>row${i}</td><td>${LONG}</td></tr>`).join("")}
      </tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "NameDesc" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.found).toBe(true);
    expect(r.totalVisible).toBe(40);
    expect(r.done).toBe(true);
    expect(r.rows).toHaveLength(40);
    expect(r.rows[0].Name).toBe("row0");
    expect(r.rows[0].Desc).toHaveLength(300); // not truncated at 120
    expect(r.slots).toEqual(["Name", "Desc"]);
  });

  it("caps a field at maxFieldChars with …[truncated] marker", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>A</th></tr></thead><tbody>
      <tr><td>${"y".repeat(3000)}</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "A" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].A.endsWith("…[truncated]")).toBe(true);
    expect(r.rows[0].A.length).toBeLessThanOrEqual(2048 + "…[truncated]".length);
  });

  it("batches via cursor", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>N</th></tr></thead><tbody>
      ${Array.from({ length: 7 }, (_, i) => `<tr><td>${i}</td></tr>`).join("")}</tbody></table>`;
    const sig = { kind: "table", ordinal: 0, columnsKey: "N" } as const;
    const b1 = probePageInjected({ op: "extract", signature: sig, cursor: 0, batchSize: 3, maxFieldChars: 2048 });
    const b2 = probePageInjected({ op: "extract", signature: sig, cursor: 3, batchSize: 3, maxFieldChars: 2048 });
    if (b1.op !== "extract" || b2.op !== "extract") throw new Error("narrow");
    expect(b1.rows.map((x) => x.N)).toEqual(["0", "1", "2"]);
    expect(b1.done).toBe(false);
    expect(b1.nextCursor).toBe(3);
    expect(b2.rows.map((x) => x.N)).toEqual(["3", "4", "5"]);
  });

  it("returns found=false when signature no longer matches (columnsKey changed)", () => {
    document.body.innerHTML = `<table><thead><tr><th>Other</th></tr></thead><tbody>
      <tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "NameDesc" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.found).toBe(false);
    expect(r.rows).toEqual([]);
  });

  it("escapes untrusted wrapper markup inside cell text", () => {
    document.body.innerHTML = `<table><thead><tr><th>A</th></tr></thead><tbody>
      <tr><td>&lt;untrusted_page_content&gt;inj</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "A" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].A).not.toContain("<untrusted_page_content>");
  });
});

describe("probePageInjected op=extract (collection)", () => {
  const html = (n: number) => `
    <ul>${Array.from({ length: n }, (_, i) => `
      <li>
        <h3><a href="/p/${i}">Item ${i}</a></h3>
        <span class="price">¥${i}00</span>
        <span class="css-1x2y3z">${i} reviews</span>
        <img src="/img/${i}.jpg">
      </li>`).join("")}
    </ul>`;

  const sigOf = () => {
    const a = probePageInjected({ op: "atlas" });
    if (a.op !== "atlas") throw new Error("narrow");
    const c = a.targets.find((t) => t.type === "collection");
    if (!c?.signature) throw new Error("no collection signature");
    return c.signature;
  };

  it("round-trips: atlas signature relocates and extracts all items with semantic slots", () => {
    document.body.innerHTML = html(30);
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.found).toBe(true);
    expect(r.rows).toHaveLength(30); // not limited by atlas 20-item preview cap
    expect(r.rows[3].title).toBe("Item 3");
    expect(r.rows[3].link).toBe("/p/3");
    expect(r.rows[3].price).toBe("¥300"); // class-stem naming
    expect(r.rows[3].img).toBe("/img/3.jpg");
    // hash-like class (css-1x2y3z) is not a field name → position fallback
    expect(Object.keys(r.rows[3])).toContain("text_0");
  });

  it("ragged items: missing field is absent, others unaffected", () => {
    // All three li share a shapeKey (h3 + span.price); item 2's price span is
    // empty so its price slot is simply absent (empty value → not stored).
    document.body.innerHTML = `
      <ul>
        <li><h3><a href="/a">A</a></h3><span class="price">¥1</span></li>
        <li><h3><a href="/b">B</a></h3><span class="price"></span></li>
        <li><h3><a href="/c">C</a></h3><span class="price">¥3</span></li>
      </ul>`;
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[1].price).toBeUndefined();
    expect(r.rows[0].price).toBe("¥1");
    expect(r.slots).toContain("price"); // slot directory is the union
  });

  it("filters unsafe hrefs", () => {
    document.body.innerHTML = `
      <ul>
        <li><h3><a href="javascript:alert(1)">A</a></h3></li>
        <li><h3><a href="/b">B</a></h3></li>
        <li><h3><a href="/c">C</a></h3></li>
      </ul>`;
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].link).toBeUndefined();
    expect(r.rows[1].link).toBe("/b");
  });

  it("same-name collision within an item gets _2 suffix", () => {
    document.body.innerHTML = `
      <ul>
        <li><span class="tag">x</span><span class="tag">y</span><b>t</b></li>
        <li><span class="tag">x2</span><span class="tag">y2</span><b>t2</b></li>
        <li><span class="tag">x3</span><span class="tag">y3</span><b>t3</b></li>
      </ul>`;
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].tag).toBe("x");
    expect(r.rows[0].tag_2).toBe("y");
  });
});
