import type { DecryptedInstance } from "@/lib/instances";
import type { BuiltinProvider } from "@/lib/model-router";
import { getProviderMeta, resolveEndpointVariant } from "@/lib/model-router";
import { CUSTOM_PREFIX } from "@/lib/custom-providers";
import { providerDisplayName, useT } from "@/lib/i18n";
import ProviderIcon from "./ProviderIcon";
import { Collapse } from "./ui/Collapse";

interface Props {
  instances: DecryptedInstance[];
  customProviderNames?: Record<string, string>;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  renderForm: (id: string) => React.ReactNode;
}

export default function InstancesList(props: Props) {
  const t = useT();
  return (
    <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      {props.instances.map((inst, i) => {
        const isOpen = props.expandedId === inst.id;
        const providerMeta = !inst.provider.startsWith(CUSTOM_PREFIX)
          ? getProviderMeta(inst.provider as BuiltinProvider)
          : null;
        const displayName = providerMeta
          ? providerDisplayName(providerMeta, t)
          : props.customProviderNames?.[inst.provider] ?? inst.provider;
        const variantLabel = (() => {
          if (!inst.endpointVariant || inst.provider.startsWith(CUSTOM_PREFIX)) return null;
          return providerMeta ? resolveEndpointVariant(providerMeta, inst.endpointVariant)?.label ?? null : null;
        })();
        return (
          <div key={inst.id} className={i > 0 ? "border-t border-line" : ""}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => props.onToggleExpand(inst.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.onToggleExpand(inst.id);
                }
              }}
              className="flex w-full cursor-pointer items-center gap-3 px-[15px] py-[15px] text-left hover:bg-field focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <ProviderIcon provider={inst.provider} size={36} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-fg-1">
                  {displayName}
                  {variantLabel && (
                    <span className="ml-1.5 whitespace-nowrap rounded bg-line px-1 py-px text-[10px] font-normal text-fg-2">{variantLabel}</span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-fg-3">{maskKey(inst.apiKey)}</div>
              </div>
              <svg
                width="9"
                height="9"
                viewBox="0 0 9 9"
                fill="none"
                aria-hidden
                className="flex-shrink-0 text-fg-3"
                style={{ transform: isOpen ? "rotate(180deg)" : "none" }}
              >
                <path d="M2.5 3.5L4.5 5.5L6.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <Collapse open={isOpen} className="border-t border-line bg-surface">{props.renderForm(inst.id)}</Collapse>
          </div>
        );
      })}
    </div>
  );
}

function maskKey(k: string) {
  return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
