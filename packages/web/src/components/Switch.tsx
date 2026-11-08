/**
 * On/off setting (a native checkbox with role="switch").
 *   <Switch label="Void on 5xx" hint="Seller errors are never billed" checked={rules.on5xx}
 *     onChange={(on) => setRules({ ...rules, on5xx: on })} />
 */
import type { ReactNode } from "react";

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Switch({ label, checked, onChange, hint, disabled, className, id }: SwitchProps) {
  return (
    <label className={["ui-switch", className].filter(Boolean).join(" ")}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-switch-track" aria-hidden="true" />
      <span className="ui-switch-text">
        {label}
        {hint != null ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
