export interface InteractiveElementSummary {
  pieIdx: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  placeholder: string;
  label: string;
  section: string;
  type: string;
  contenteditable: boolean;
  disabled: boolean;
  checked: boolean;
  selected: boolean;
  /** Raw aria-haspopup value ("true" | "menu" | "listbox" | ... | ""). */
  hasPopup?: string;
  /** Raw aria-expanded value ("true" | "false" | ""). */
  ariaExpanded?: string;
}

export interface InteractiveSummaryMatch {
  pieIdx: number | null;
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  contenteditable?: boolean;
  matched: string;
  snippet: string;
}
