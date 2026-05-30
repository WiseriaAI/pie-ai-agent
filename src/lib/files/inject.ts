import type { FileAttachment } from "./types";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "@/lib/agent/untrusted-wrappers";

export function buildLocalFileWrapper(opts: {
  name: string;
  mime: string;
  text: string;
  truncated: boolean;
  totalPages?: number;
}): string {
  const pagesAttr = opts.totalPages !== undefined ? ` total_pages="${opts.totalPages}"` : "";
  return (
    `<untrusted_local_file name="${escapeWrapperAttribute(opts.name)}" ` +
    `mime="${escapeWrapperAttribute(opts.mime)}" truncated="${opts.truncated}"${pagesAttr}>\n` +
    `${escapeUntrustedWrappers(opts.text)}\n</untrusted_local_file>`
  );
}

export function fileAttachmentToWrapper(att: FileAttachment): string {
  return buildLocalFileWrapper({ name: att.name, mime: att.mime, text: att.text, truncated: att.truncated });
}
