import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertSafeRel, safeRelPath } from "../src/skill-store";

// #359 Windows 路径守卫：assertSafeRel 是平台无关的 rel 字符串闸，在 mac 上也能用
// win32 攻击串直测（反斜杠 / 盘符 / UNC / 遍历 / 绝对）——workspace/skill 锁定不变量
// 在 win32 上同样成立。

test("assertSafeRel accepts legit relative paths (mac + win-authored forward-slash)", () => {
  for (const ok of ["SKILL.md", "scripts/foo.py", "out.csv", "a/b/c.txt", "file.with.dots", "a..b/c"]) {
    expect(assertSafeRel(ok)).toBe(ok); // a..b 含 ".." 子串但不是完整段 → 放行
  }
});

test("assertSafeRel rejects backslash escapes (win32 separator / traversal)", () => {
  for (const bad of ["..\\..\\etc", "sub\\file", "a\\b", "..\\secret", "scripts\\..\\..\\x"]) {
    expect(() => assertSafeRel(bad)).toThrow();
  }
});

test("assertSafeRel rejects UNC prefixes (\\\\server\\share)", () => {
  for (const bad of ["\\\\server\\share", "\\\\?\\C:\\Windows", "\\\\.\\pipe\\evil"]) {
    expect(() => assertSafeRel(bad)).toThrow();
  }
});

test("assertSafeRel rejects drive letters — absolute (C:\\) and drive-relative (C:foo)", () => {
  for (const bad of ["C:\\Windows\\System32", "c:\\x", "C:foo", "D:secret", "Z:relative\\path"]) {
    expect(() => assertSafeRel(bad)).toThrow();
  }
});

test("assertSafeRel rejects POSIX-absolute and parent traversal", () => {
  for (const bad of ["/etc/passwd", "/abs", "..", "../secret", "../../etc/passwd", "a/../../b"]) {
    expect(() => assertSafeRel(bad)).toThrow();
  }
});

test("assertSafeRel rejects empty / non-string", () => {
  expect(() => assertSafeRel("")).toThrow();
  // @ts-expect-error 运行期不可信输入可能非字符串
  expect(() => assertSafeRel(null)).toThrow();
  // @ts-expect-error
  expect(() => assertSafeRel(undefined)).toThrow();
});

test("safeRelPath enforces the win32 string guard before native resolution", () => {
  // realpath 规范化：macOS tmpdir 经 /var → /private/var symlink，而 safeRelPath 内部
  // realpathSync(skillDir) 会返回规范化根，期望值须同样规范化，否则 mac 上必红。
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pie-guard-")));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "run.py"), "print(1)");
  // 合法：解析到根内
  expect(safeRelPath(root, "scripts/run.py")).toBe(join(root, "scripts", "run.py"));
  // win32 越权向量在 native(posix) resolve 之前就被字符串守卫拦下
  for (const bad of ["..\\..\\etc", "C:\\Windows", "\\\\server\\share", "C:foo"]) {
    expect(() => safeRelPath(root, bad)).toThrow();
  }
});
