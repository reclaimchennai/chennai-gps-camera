import { createContext, useContext, useId } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { goBack } from "../nav";

/**
 * Enter commits + dismisses the keyboard on single-line inputs (the tags
 * field's behaviour, app-wide). Values already save on change; blur is
 * what releases the user — without it they had to gesture back out of
 * the screen to continue.
 */
export function blurOnEnter(
  e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>
): void {
  if (e.key === "Enter") (e.target as HTMLElement).blur();
}

export function Screen({
  title,
  children,
  actions,
  noPad,
  onBack,
  backLabel,
  backIcon,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  noPad?: boolean;
  /** overrides leaving the screen — the gallery's selection mode uses it
   *  to make Back mean "drop the selection" instead of "leave" */
  onBack?: () => void;
  backLabel?: string;
  backIcon?: ReactNode;
}) {
  return (
    <div className="screen" style={{ position: "fixed", inset: 0, zIndex: 10, background: "var(--bg)" }}>
      <header className="screen-header">
        <button
          className="icon-btn"
          onClick={onBack ?? goBack}
          aria-label={backLabel ?? "Back"}
        >
          {backIcon ?? <ArrowLeft size={20} />}
        </button>
        <h1>{title}</h1>
        {actions}
      </header>
      <main
        className="screen-body"
        style={noPad ? { padding: 0, display: "flex", flexDirection: "column" } : undefined}
      >
        {children}
      </main>
    </div>
  );
}

/**
 * The id of the Row label a control sits beside.
 *
 * Every switch in Settings is an empty <button role="switch"> — visually
 * it is obviously paired with the label to its left, but a screen reader
 * announces "switch, on" with no indication of WHAT is on. Rather than
 * repeat the label at 40-odd call sites, the Row publishes its label's id
 * and the control points at it.
 */
const RowLabelId = createContext<string | undefined>(undefined);

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** overrides the surrounding Row's label, for switches used alone */
  label?: string;
}) {
  const labelledBy = useContext(RowLabelId);
  return (
    <button
      className="switch"
      data-on={on}
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-labelledby={label ? undefined : labelledBy}
      onClick={() => onChange(!on)}
    />
  );
}

export function Row({
  label,
  hint,
  onClick,
  children,
}: {
  label: ReactNode;
  hint?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className={`row${onClick ? " tappable" : ""}`} onClick={onClick}>
      <div className="grow">
        <div className="label" id={labelId}>
          {label}
        </div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <RowLabelId.Provider value={labelId}>{children}</RowLabelId.Provider>
      {onClick && !children && (
        <span className="chev">
          <ChevronRight size={18} />
        </span>
      )}
    </div>
  );
}
