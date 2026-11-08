/**
 * Labeled form controls sharing one look: Input, Textarea, Select.
 *   <Input label="Hold" prefix="$" mono value={v} onChange={(e) => setV(e.target.value)} hint="Max $10,000" />
 *   <Textarea label="Budget in plain English" rows={4} error={error} />
 *   <Select label="Mode" value={mode} onChange={...}><option value="llm">Gemma</option></Select>
 * `label`, `hint`, `error` are optional; ids are generated and wired to aria attributes. `mono` sets the
 * value in the monospace face (amounts, ids, paths).
 */
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";

interface FieldChrome {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  className,
  invalid,
  disabled,
  mono,
  children,
}: FieldChrome & { id: string; invalid: boolean; disabled?: boolean; mono?: boolean; children: ReactNode }) {
  return (
    <div className={["ui-field", className].filter(Boolean).join(" ")}>
      {label ? (
        <label className="ui-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <div className={["ui-control", mono && "ui-control--mono"].filter(Boolean).join(" ")} data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
        {children}
      </div>
      {error ? (
        <span className="ui-error" id={`${id}-error`}>
          {error}
        </span>
      ) : hint ? (
        <span className="ui-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: ReactNode, error: ReactNode): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix">, FieldChrome {
  prefix?: ReactNode;
  suffix?: ReactNode;
  mono?: boolean;
}

export function Input({ label, hint, error, className, prefix, suffix, mono, id, disabled, ...rest }: InputProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} className={className} invalid={Boolean(error)} disabled={disabled} mono={mono}>
      {prefix ? <span className="ui-affix">{prefix}</span> : null}
      <input id={fieldId} disabled={disabled} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(fieldId, hint, error)} {...rest} />
      {suffix ? <span className="ui-affix">{suffix}</span> : null}
    </FieldFrame>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldChrome {}

export function Textarea({ label, hint, error, className, id, disabled, ...rest }: TextareaProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} className={className} invalid={Boolean(error)} disabled={disabled}>
      <textarea id={fieldId} disabled={disabled} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(fieldId, hint, error)} {...rest} />
    </FieldFrame>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldChrome {}

export function Select({ label, hint, error, className, id, children, disabled, ...rest }: SelectProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} className={className} invalid={Boolean(error)} disabled={disabled}>
      <select id={fieldId} disabled={disabled} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(fieldId, hint, error)} {...rest}>
        {children}
      </select>
      <span className="ui-affix" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </FieldFrame>
  );
}
