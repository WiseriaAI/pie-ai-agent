export interface FileAttachment {
  kind: "file";
  id: string;
  name: string;
  mime: string;
  text: string;       // extracted, already truncated
  truncated: boolean;
  totalChars: number; // pre-truncation length
  source: "picker" | "uri";
}
