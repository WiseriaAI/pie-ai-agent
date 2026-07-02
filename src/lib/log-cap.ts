// src/lib/log-cap.ts
//
// Byte-budget cap for the "attach recent logs" feedback payload. The backend
// enforces two independent limits: a UTF-16 character count on `logs`
// (logs_too_large) AND a 256KB byte-size bodyLimit on the whole request. CJK
// text is ~3 bytes/char in UTF-8, so a string within the character limit can
// still blow past the byte limit — this helper enforces the byte side.
export function capLogBytes(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  // Truncate to the byte budget, which may cut a multi-byte char mid-sequence
  // → decode with fatal:false (emits U+FFFD for the partial tail) then strip it.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/�+$/u, "");
}
