import { escapeUntrustedWrappers } from "../../untrusted-wrappers";
import type { AtlasTarget, PageAtlasState } from "./types";

function attr(name: string, value: string | number | boolean): string {
  return `${name}="${xmlAttr(value)}"`;
}

function optionalAttr(name: string, value: string | number | boolean | undefined): string | null {
  return value === undefined ? null : attr(name, value);
}

function xmlAttr(value: string | number | boolean): string {
  return escapeUntrustedWrappers(String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function xmlText(value: string): string {
  return escapeUntrustedWrappers(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nextActionsFor(target: AtlasTarget): string[] {
  if (target.type === "collection" || target.type === "table") return ["read_struct"];
  return ["read_target"];
}

export function renderAtlasError(message: string): string {
  return `<page_atlas_error>${xmlText(message)}</page_atlas_error>`;
}

export function renderPageAtlas(atlas: PageAtlasState): string {
  const rootAttrs = [
    attr("atlas_id", atlas.atlasId),
    attr("tab_id", atlas.tabId),
    attr("url", atlas.url),
    attr("title", atlas.title),
  ];

  const actionLines: string[] = ["  <action_surfaces>"];
  for (const form of atlas.forms) {
    const attrs = [
      attr("id", form.id),
      attr("label", form.label),
      attr("frame_id", form.frameId),
      attr("fields", form.fields.join(",")),
      optionalAttr("submit_control_id", form.submitControlId),
    ].filter((item): item is string => item !== null);
    actionLines.push(`    <form ${attrs.join(" ")} />`);
  }
  for (const control of atlas.controls) {
    const attrs = [
      attr("id", control.id),
      attr("type", control.type),
      attr("label", control.label),
      attr("frame_id", control.frameId),
      attr("pie_idx", control.pieIdx),
      optionalAttr("value", control.value),
      optionalAttr("disabled", control.disabled),
      optionalAttr("checked", control.checked),
    ].filter((item): item is string => item !== null);
    actionLines.push(`    <control ${attrs.join(" ")} />`);
  }
  actionLines.push("  </action_surfaces>");

  const dataLines: string[] = ["  <data_surfaces>"];
  for (const target of atlas.targets) {
    const attrs = [
      attr("id", target.id),
      attr("type", target.type),
      attr("label", target.label),
      attr("frame_id", target.frameId),
      attr("confidence", target.confidence),
      optionalAttr("visible_count", target.visibleCount),
      optionalAttr("estimated_total", target.estimatedTotal),
    ].filter((item): item is string => item !== null);
    dataLines.push(`    <target ${attrs.join(" ")}>`);
    if (target.summary) {
      dataLines.push(`      <summary>${xmlText(target.summary)}</summary>`);
    }
    for (const fieldGuess of target.fieldGuesses ?? []) {
      dataLines.push(
        `      <field_guess ${attr("name", fieldGuess.name)} ${attr("confidence", fieldGuess.confidence)} />`,
      );
    }
    if (target.columns && target.columns.length > 0) {
      dataLines.push("      <columns>");
      for (const column of target.columns) {
        dataLines.push(`        <column>${xmlText(column)}</column>`);
      }
      dataLines.push("      </columns>");
    }
    dataLines.push("      <next_actions>");
    for (const action of nextActionsFor(target)) {
      dataLines.push(
        `        <next_action ${attr("name", action)} ${attr("atlas_id", atlas.atlasId)} ${attr("target_id", target.id)} />`,
      );
    }
    dataLines.push("      </next_actions>");
    dataLines.push("    </target>");
  }
  dataLines.push("  </data_surfaces>");

  return [
    `<page_atlas ${rootAttrs.join(" ")}>`,
    ...actionLines,
    ...dataLines,
    "</page_atlas>",
  ].join("\n");
}
