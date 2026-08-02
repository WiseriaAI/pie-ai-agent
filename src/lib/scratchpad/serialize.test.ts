import { describe, it, expect } from "vitest";
import { toCsv, columnsOf } from "./serialize";

describe("toCsv", () => {
  it("writes a header + one line per record", () => {
    const csv = toCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(csv).toBe("a,b\n1,x\n2,y");
  });

  it("quotes cells containing comma, quote or newline", () => {
    const csv = toCsv([{ t: 'he said "hi", loudly' }, { t: "two\nlines" }]);
    expect(csv).toBe('t\n"he said ""hi"", loudly"\n"two\nlines"');
  });

  it("renders null/undefined as empty and objects as JSON", () => {
    const csv = toCsv([{ a: null, b: undefined, c: { k: 1 }, d: [1, 2] }]);
    expect(csv).toBe('a,b,c,d\n,,"{""k"":1}","[1,2]"');
  });

  it("fills missing keys so rows stay aligned", () => {
    const csv = toCsv([{ a: 1 }, { b: 2 }]);
    expect(csv).toBe("a,b\n1,\n,2");
  });

  it("puts declared fields first but keeps extra keys", () => {
    expect(columnsOf([{ z: 1, name: "n", extra: 3 }], ["name", "z"])).toEqual(["name", "z", "extra"]);
  });
});
