// Placeholder glyphs for the quote / file / close affordances used by the
// Tint-Pill quote & file chips. These are STAND-INS — when the final icon set
// arrives, swap the SVG paths here and every consumer updates automatically.
// All use `currentColor` so the caller controls tint via text-* classes.

export function QuoteGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M195.2 458.24a259.84 259.84 0 0 1 177.92-160c92.16-29.44 47.04-128-34.56-102.72C146.56 249.28 32 395.52 32 586.56 32 736 117.12 832 249.28 832s215.04-79.68 215.04-203.52c0-177.28-168-219.52-269.12-170.24z m527.68 0a259.84 259.84 0 0 1 177.92-160c91.2-29.12 48-128-34.56-102.72-192 54.08-306.56 200-306.56 391.36 0 149.12 85.44 245.12 217.28 245.12S992 752.32 992 628.48c0-176.64-167.04-219.84-269.12-170.24z" />
    </svg>
  );
}

// PDF document.
export function PdfFileGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M531.3 574.4l0.3-1.4c5.8-23.9 13.1-53.7 7.4-80.7-3.8-21.3-19.5-29.6-32.9-30.2-15.8-0.7-29.9 8.3-33.4 21.4-6.6 24-0.7 56.8 10.1 98.6-13.6 32.4-35.3 79.5-51.2 107.5-29.6 15.3-69.3 38.9-75.2 68.7-1.2 5.5 0.2 12.5 3.5 18.8 3.7 7 9.6 12.4 16.5 15 3 1.1 6.6 2 10.8 2 17.6 0 46.1-14.2 84.1-79.4 5.8-1.9 11.8-3.9 17.6-5.9 27.2-9.2 55.4-18.8 80.9-23.1 28.2 15.1 60.3 24.8 82.1 24.8 21.6 0 30.1-12.8 33.3-20.5 5.6-13.5 2.9-30.5-6.2-39.6-13.2-13-45.3-16.4-95.3-10.2-24.6-15-40.7-35.4-52.4-65.8zM421.6 726.3c-13.9 20.2-24.4 30.3-30.1 34.7 6.7-12.3 19.8-25.3 30.1-34.7z m87.6-235.5c5.2 8.9 4.5 35.8 0.5 49.4-4.9-19.9-5.6-48.1-2.7-51.4 0.8 0.1 1.5 0.7 2.2 2z m-1.6 120.5c10.7 18.5 24.2 34.4 39.1 46.2-21.6 4.9-41.3 13-58.9 20.2-4.2 1.7-8.3 3.4-12.3 5 13.3-24.1 24.4-51.4 32.1-71.4z m155.6 65.5c0.1 0.2 0.2 0.5-0.4 0.9h-0.2l-0.2 0.3c-0.8 0.5-9 5.3-44.3-8.6 40.6-1.9 45 7.3 45.1 7.4z" />
      <path d="M854.6 288.6L639.4 73.4c-6-6-14.1-9.4-22.6-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.7-9.4-22.7zM790.2 326H602V137.8L790.2 326z m1.8 562H232V136h302v216c0 23.2 18.8 42 42 42h216v494z" />
    </svg>
  );
}

// Text document (.md / .txt / .json / …).
export function TextFileGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M854.6 288.6L639.4 73.4c-6-6-14.1-9.4-22.6-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.7-9.4-22.7zM790.2 326H602V137.8L790.2 326z m1.8 562H232V136h302v216c0 23.2 18.8 42 42 42h216v494z" />
      <path d="M504 618H320c-4.4 0-8 3.6-8 8v48c0 4.4 3.6 8 8 8h184c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8zM312 490v48c0 4.4 3.6 8 8 8h384c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8H320c-4.4 0-8 3.6-8 8z" />
    </svg>
  );
}

// Generic / other file.
export function FileGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M854.6 288.6L639.4 73.4c-6-6-14.1-9.4-22.6-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.7-9.4-22.7zM790.2 326H602V137.8L790.2 326z m1.8 562H232V136h302v216c0 23.2 18.8 42 42 42h216v494z" />
    </svg>
  );
}

// --- Brand mark: official 4-color Google "G". Fixed brand colors (NOT currentColor). ---
export function GoogleGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Spark / sparkle accent for the intro-offer badge. Uses currentColor.
export function SparkGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M8 1.5c.3 2.7 1.8 4.2 4.5 4.5-2.7.3-4.2 1.8-4.5 4.5-.3-2.7-1.8-4.2-4.5-4.5C6.2 5.7 7.7 4.2 8 1.5Z" />
    </svg>
  );
}

// Right-pointing chevron. Uses currentColor.
export function ChevronGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} fill="none" aria-hidden>
      <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
