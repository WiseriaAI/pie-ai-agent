/**
 * UI icon size scale (px) — sm=按钮内联/密集操作, md=独立 icon button/状态,
 * lg=品牌/强调入口. See docs/specs/2026-06-14-ui-design-system-motion-polish.md §4.1.
 *
 * Use these for SVG width/height. Radius / type / motion live as CSS @theme
 * tokens (utility classes), not here.
 */
export const ICON_SIZE = { sm: 14, md: 16, lg: 20 } as const;
export type IconSizeKey = keyof typeof ICON_SIZE;
