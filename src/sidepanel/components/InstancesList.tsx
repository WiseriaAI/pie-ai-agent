import type { DecryptedInstance } from "@/lib/instances";
import ProviderIcon from "./ProviderIcon";

interface Props {
  instances: DecryptedInstance[];
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  renderForm: (id: string) => React.ReactNode;
}

export default function InstancesList(props: Props) {
  return (
    <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      {props.instances.map((inst, i) => {
        const isOpen = props.expandedId === inst.id;
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
                  {inst.nickname}
                  <span className="ml-1 text-[11px] font-normal text-fg-3">· {inst.provider}</span>
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
            {isOpen && <div className="drawer-down border-t border-line bg-surface">{props.renderForm(inst.id)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function maskKey(k: string) {
  return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
