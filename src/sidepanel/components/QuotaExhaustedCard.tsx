interface Props {
  kind: "quota" | "upgrade";
  onByok: () => void;
  onBuy: () => void;
}

export function QuotaExhaustedCard({ kind, onByok, onBuy }: Props) {
  const isQuota = kind === "quota";
  return (
    <div className="rounded-lg border border-warning-line bg-warning-tint px-4 py-3.5 flex flex-col gap-3 text-warning">
      <div className="text-[13px] font-medium">
        {isQuota ? "免费额度用尽" : "该思考强度需升级"}
      </div>
      <div className="text-[12px]">
        {isQuota
          ? "你的官方免费额度已到上限。可自带 API key 继续，或购买 credit 包。"
          : "高级思考强度仅对付费用户开放。"}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onByok}
          className="rounded-lg border border-line px-3 py-1.5 text-[12px]"
        >
          自带 key（BYOK）
        </button>
        <button
          type="button"
          onClick={onBuy}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white"
        >
          购买 credit
        </button>
      </div>
    </div>
  );
}
