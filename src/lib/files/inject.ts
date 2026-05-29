import type { FileAttachment } from "./types";
import { escapeUntrustedWrappers, escapeWrapperAttribute } from "@/lib/agent/untrusted-wrappers";

export function fileAttachmentToWrapper(att: FileAttachment): string {
  return (
    `<untrusted_local_file name="${escapeWrapperAttribute(att.name)}" ` +
    `mime="${escapeWrapperAttribute(att.mime)}" truncated="${att.truncated}">\n` +
    `${escapeUntrustedWrappers(att.text)}\n</untrusted_local_file>`
  );
}
