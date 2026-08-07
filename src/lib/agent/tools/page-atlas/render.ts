import { escapeUntrustedWrappers } from "../../untrusted-wrappers";
import type { AtlasControl, AtlasTarget, PageAtlasState } from "./types";

/**
 * 每份 atlas 最多渲染多少个控件 / 目标。
 *
 * 实测:一个普通页面能产出 484 个 control,占单份 atlas 20881 tokens 中的
 * 14483(69%)。全量枚举让 progressive disclosure 的「第一层」本身就是 1-3 万
 * token 的结果,后面所有分层都失去意义。
 *
 * 上限是有损的,兜底有两条,都写进 <omitted> 的 hint 让 LLM 看得见:
 *   - `read_page({mode:"atlas", query:"…"})` 按 label/type 定向召回;
 *   - `mode:"interactive"` 仍然给到 300 条完整索引。
 */
const MAX_CONTROLS = 40;
const MAX_TARGETS = 20;

export interface RenderAtlasOptions {
  /** 按 label / type 子串过滤(大小写不敏感),用于定向召回被省略的条目。 */
  query?: string;
  maxControls?: number;
  maxTargets?: number;
}

/**
 * 控件排序优先级(小的先)。文本输入 > 选择器 > 按钮 > 链接 > 其它 ——
 * 与 read-page.ts 的 interactivePriority 同源:任务里要「操作」的控件绝大多数
 * 是前三类,而占满页面的通常是链接。
 */
function controlPriority(control: AtlasControl): number {
  const type = control.type.toLowerCase();
  if (type === "textbox" || type === "input" || type === "textarea" || type === "searchbox") return 0;
  if (type === "combobox" || type === "listbox" || type === "select" || type === "checkbox" || type === "radio") return 1;
  if (type === "button" || type === "submit" || type === "tab") return 2;
  if (type === "link" || type === "a") return 3;
  return 4;
}

function matchesQuery(haystack: string[], query: string): boolean {
  const q = query.toLowerCase();
  return haystack.some((value) => value.toLowerCase().includes(q));
}

/**
 * 过滤 → 排序 → 截断。返回选中项与被省略的条数。
 * 排序稳定:视口内优先,再按类型优先级,最后保持原始 DOM 顺序 —— 同一页面重读
 * 时输出字节稳定,前缀缓存才可能命中。
 */
function selectControls(
  controls: AtlasControl[],
  query: string | undefined,
  max: number,
): { selected: AtlasControl[]; omitted: number } {
  const pool = query
    ? controls.filter((c) => matchesQuery([c.label, c.type, c.value ?? ""], query))
    : controls;
  const ranked = pool
    .map((control, order) => ({ control, order }))
    .sort(
      (a, b) =>
        Number(b.control.inView ?? false) - Number(a.control.inView ?? false) ||
        controlPriority(a.control) - controlPriority(b.control) ||
        a.order - b.order,
    );
  // 排名只用来「选」;选中后按原始 DOM 顺序输出,读起来才和页面视觉顺序一致。
  const selected = ranked
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.control);
  return { selected, omitted: Math.max(0, ranked.length - max) };
}

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

export function renderAtlasError(message: string): string {
  return `<page_atlas_error>${xmlText(message)}</page_atlas_error>`;
}

export function renderPageAtlas(atlas: PageAtlasState, options: RenderAtlasOptions = {}): string {
  const query = options.query?.trim() || undefined;
  const rootAttrs = [
    attr("atlas_id", atlas.atlasId),
    attr("tab_id", atlas.tabId),
    attr("url", atlas.url),
    attr("title", atlas.title),
  ];
  if (query) rootAttrs.push(attr("query", query));

  const { selected: controls, omitted: omittedControls } = selectControls(
    atlas.controls,
    query,
    options.maxControls ?? MAX_CONTROLS,
  );

  const allTargets = query
    ? atlas.targets.filter((t) => matchesQuery([t.label, t.type, t.summary, ...(t.columns ?? [])], query))
    : atlas.targets;
  const maxTargets = options.maxTargets ?? MAX_TARGETS;
  const targets = allTargets.slice(0, maxTargets);
  const omittedTargets = Math.max(0, allTargets.length - maxTargets);

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
  for (const control of controls) {
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
  for (const target of targets) {
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
    // 这里原本有 <next_actions>:它只是 target.type 的固定映射
    // (collection/table → read_struct,其余 → read_target),却把 20 字符的
    // atlas_id 在每个 target 上重复一遍,实测 54 个 target 花掉 1388 tokens。
    // 规则已移进 system prompt,说一次就够。
    dataLines.push("    </target>");
  }
  dataLines.push("  </data_surfaces>");

  // 截断必须是显式的:静默丢弃会让 LLM 以为「页面上就这些控件」,进而得出错误
  // 结论或反复重读。给出条数 + 两条召回路径,它才能自己规划下一次定点读取。
  const omittedLines: string[] = [];
  if (omittedControls > 0 || omittedTargets > 0) {
    const attrs = [attr("controls", omittedControls), attr("targets", omittedTargets)];
    const hint = query
      ? `Filtered by query="${query}". Widen or change the query to see other entries.`
      : `Showing the most relevant entries (visible in viewport first). To find a specific one, call read_page({mode:"atlas", query:"<keyword>"}); for a full element index use read_page({mode:"interactive"}).`;
    omittedLines.push(`  <omitted ${attrs.join(" ")} ${attr("hint", hint)} />`);
  }

  return [
    `<page_atlas ${rootAttrs.join(" ")}>`,
    ...actionLines,
    ...dataLines,
    ...omittedLines,
    "</page_atlas>",
  ].join("\n");
}
