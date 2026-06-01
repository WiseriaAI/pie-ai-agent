export interface ThinkSegment {
  kind: "text" | "think";
  text: string;
}

export interface ThinkTagSplitter {
  feed(chunk: string): ThinkSegment[];
  flush(): ThinkSegment[];
}

const OPEN = "<think>";
const CLOSE = "</think>";

/** 返回 s 末尾是否为 tag 的一个真前缀（含从某个 '<' 起算），是则返回该前缀起点 index，否则 -1。 */
function partialTagStart(s: string, tag: string): number {
  const maxLen = Math.min(s.length, tag.length - 1);
  for (let len = maxLen; len >= 1; len--) {
    const tail = s.slice(s.length - len);
    if (tag.startsWith(tail)) return s.length - len;
  }
  return -1;
}

export function createThinkTagSplitter(): ThinkTagSplitter {
  let inside = false;
  let carry = ""; // 可能是被切断的 tag 前缀

  function process(input: string, isFlush: boolean): ThinkSegment[] {
    let buf = carry + input;
    carry = "";
    const out: ThinkSegment[] = [];

    while (buf.length > 0) {
      const tag = inside ? CLOSE : OPEN;
      const idx = buf.indexOf(tag);
      if (idx !== -1) {
        const before = buf.slice(0, idx);
        if (before) out.push({ kind: inside ? "think" : "text", text: before });
        inside = !inside;
        buf = buf.slice(idx + tag.length);
        continue;
      }
      // 无完整 tag。若非 flush，检查末尾是否为被切断的 tag 前缀，留到下次。
      if (!isFlush) {
        const p = partialTagStart(buf, tag);
        if (p !== -1) {
          const emit = buf.slice(0, p);
          if (emit) out.push({ kind: inside ? "think" : "text", text: emit });
          carry = buf.slice(p);
          return out;
        }
      }
      if (buf) out.push({ kind: inside ? "think" : "text", text: buf });
      buf = "";
    }
    return out;
  }

  return {
    feed: (chunk) => process(chunk, false),
    flush: () => process("", true),
  };
}
