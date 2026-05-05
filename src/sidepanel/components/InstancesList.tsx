import type { DecryptedInstance } from "@/lib/instances";

interface Props {
  instances: DecryptedInstance[];
  activeId: string | null;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetActive: (id: string) => void;
  renderForm: (id: string) => React.ReactNode;
}

export default function InstancesList(props: Props) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
      {props.instances.map((inst) => {
        const isActive = props.activeId === inst.id;
        const isOpen = props.expandedId === inst.id;
        return (
          <div key={inst.id} className="bg-surface">
            <button
              onClick={() => props.onToggleExpand(inst.id)}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-field"
            >
              <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isActive ? "bg-accent" : "bg-fg-3"}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-fg-1">
                  {inst.nickname}
                  <span className="ml-1 text-[11px] font-normal text-fg-3">· {inst.provider}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-fg-2">
                  {inst.model} · {maskKey(inst.apiKey)}
                </div>
              </div>
              {isActive ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent">ACTIVE</span>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); props.onSetActive(inst.id); }}
                  className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  Activate
                </button>
              )}
            </button>
            {isOpen && <div className="border-t border-line bg-canvas">{props.renderForm(inst.id)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function maskKey(k: string) { return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`; }
