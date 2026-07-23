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
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  noPad?: boolean;
}) {
  return (
    <div className="screen" style={{ position: "fixed", inset: 0, zIndex: 10, background: "var(--bg)" }}>
      <header className="screen-header">
        <button className="icon-btn" onClick={goBack} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <h1>{title}</h1>
        {actions}
      </header>
      <div className="screen-body" style={noPad ? { padding: 0, display: "flex", flexDirection: "column" } : undefined}>
        {children}
      </div>
    </div>
  );
}

export function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className="switch"
      data-on={on}
      role="switch"
      aria-checked={on}
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
  return (
    <div className={`row${onClick ? " tappable" : ""}`} onClick={onClick}>
      <div className="grow">
        <div className="label">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
      {onClick && !children && (
        <span className="chev">
          <ChevronRight size={18} />
        </span>
      )}
    </div>
  );
}
