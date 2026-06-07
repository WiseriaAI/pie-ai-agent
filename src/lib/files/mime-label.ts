// File-type label + human size helpers for the output_file download card.
// The label is derived from the FILENAME EXTENSION (what the user sees in the
// card title), NOT from the MIME type — the model often omits `mime`, which
// would otherwise fall back to text/plain and mislabel e.g. report.md as TEXT.

const EXT_LABELS: Record<string, string> = {
  md: "MARKDOWN",
  markdown: "MARKDOWN",
  txt: "TEXT",
  text: "TEXT",
  csv: "CSV",
  tsv: "TSV",
  json: "JSON",
  ndjson: "NDJSON",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  js: "JS",
  jsx: "JSX",
  ts: "TS",
  tsx: "TSX",
  py: "PYTHON",
  rb: "RUBY",
  go: "GO",
  rs: "RUST",
  java: "JAVA",
  c: "C",
  h: "C",
  cpp: "C++",
  sh: "SHELL",
  sql: "SQL",
  toml: "TOML",
  ini: "INI",
  log: "LOG",
};

/** filename → short uppercase type label for the file card meta line. */
export function fileTypeLabel(filename: string): string {
  const base = (filename ?? "").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "FILE"; // no extension, or a dotfile like ".gitignore"
  const ext = base.slice(dot + 1).toLowerCase();
  if (!ext) return "FILE";
  return EXT_LABELS[ext] ?? ext.toUpperCase();
}

/** bytes → "12.0 KB" style human size. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
