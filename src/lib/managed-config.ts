/**
 * 官方托管服务基址。prod 默认;`pnpm build:staging`（vite --mode staging）切到 Railway 测试环境。
 * ⬇️ 把这两个 STAGING URL 换成你的 Railway 测试环境地址（不带末尾斜杠）。
 */
const STAGING = import.meta.env.MODE === "staging";

export const ACCOUNT_BASE = STAGING
  ? "https://account-staging-ca69.up.railway.app"
  : "https://account.pie.chat";
export const GATEWAY_BASE = STAGING
  ? "https://litellm-staging-f897.up.railway.app"
  : "https://api.pie.chat";
