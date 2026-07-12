/**
 * 本地 Agent 品牌图标（#270）：inline SVG（MV3 CSP 禁外链），按 daemon
 * AGENT_CANDIDATES id 前缀键控。Claude 用 brand 色（不随主题翻转，故硬编码）；
 * Codex/通用随 currentColor。path 为 simplified 近似 mark；如替换为官方
 * simplified 资产，保持单 path、viewBox 24 与 data-brand 标注不变。
 */
export function AgentBrandIcon({ agentId, size = 14 }: { agentId: string; size?: number }) {
  if (agentId.startsWith("claude")) {
    return (
      <svg
        data-brand="claude"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#D97757"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M12 3v18" />
        <path d="M3 12h18" />
        <path d="M5.6 5.6l12.8 12.8" />
        <path d="M18.4 5.6L5.6 18.4" />
      </svg>
    );
  }
  if (agentId.startsWith("codex")) {
    return (
      <svg
        data-brand="codex"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z" />
        <path d="M12 7.2l4.1 2.4v4.8L12 16.8l-4.1-2.4V9.6L12 7.2z" />
      </svg>
    );
  }
  return (
    <svg
      data-brand="generic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}
