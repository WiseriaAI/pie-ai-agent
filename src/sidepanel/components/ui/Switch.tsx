// Toggle switch — extracted from Settings.tsx so the Bridge / Experimental
// settings pages can share it. Logic unchanged.
export function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition-colors ${
        checked ? "border-accent-line bg-accent-tint" : "border-line bg-field"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
          checked ? "translate-x-6 bg-accent" : "translate-x-1 bg-fg-3"
        }`}
      />
    </button>
  );
}
