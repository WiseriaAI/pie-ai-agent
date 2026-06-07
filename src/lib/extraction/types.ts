// src/lib/extraction/types.ts
export type FieldType = "string" | "number" | "date" | "boolean" | "url";

export interface ExtractionField {
  name: string;
  type: FieldType;
  /** 给 LLM 的定位/语义提示 */
  description?: string;
  /** B-lite:可选 NL 清洗提示,LLM 抽取时应用 */
  normalize?: string;
}

export interface ExtractionSource {
  page: number; // 1-based
  url: string;
}

/** 一行 = 用户字段 + 行级来源 */
export type ExtractionRow = Record<string, unknown> & { _source: ExtractionSource };

export interface ProducedBy {
  skillId: string;
  skillName: string;
  version: number;
}

export interface ExtractionMeta {
  extractedAt: string; // ISO
  rowCount: number;
  pageCount: number;
  producedBy: ProducedBy;
}

/** JSON 契约(给 B 的完整载体) */
export interface ExtractionResult {
  schema: ExtractionField[];
  rows: ExtractionRow[];
  meta: ExtractionMeta;
}

/** 持久化进 extraction.json */
export interface ExtractionConfig {
  version: 1;
  schema: ExtractionField[];
  /** NL 停止条件,LLM 运行时判 */
  stopCondition: string;
  output: { formats: Array<"csv" | "json">; includeSourceColumns: boolean };
}
