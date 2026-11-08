/**
 * Labeled form controls sharing one look: Input, Textarea, Select.
 *   <Input label="Hold" prefix="$" value={v} onChange={(e) => setV(e.target.value)} hint="Max $10,000" />
 *   <Textarea label="Budget in plain English" rows={4} error={error} />
 *   <Select label="Mode" value={mode} onChange={...}><option value="llm">Gemma</option></Select>
 * `label`, `hint`, `error` are optional; ids are generated and wired to aria attributes.
 */
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";

interface FieldChrome {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
}

function FieldFrame({ id, label, hint, error, className, invalid, children }: FieldChrome & { id: string; invalid: boolean; children: ReactNode }) {
  return (
    <div className={["ui-field", className].filter(Boolean).join(" ")}>
      {label ? (
        <label className="ui-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <div className="ui-control" data-invalid={invalid || undefined}>
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
}

export function Input({ label, hint, error, className, prefix, suffix, id, ...rest }: InputProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} className={className} invalid={Boolean(error)}>
      {prefix ? <span className="ui-affix">{prefix}</span> : null}
      <input id={fieldId} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(fieldId, hint, error)} {...rest} />
      {suffix ? <span className="ui-affix">{suffix}</span> : null}
    </FieldFrame>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldChrome {}

export function Textarea({ label, hint, error, className, id, ...rest }: TextareaProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} className={className} invalid={Boolean(error)}>
      <textarea id={fieldId} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(fieldId, hint, error)} {...rest} />
    </FieldFrame>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldChrome {}

export function Select({ label, hint, error, className, id, children, ...rest }: SelectProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <FieldFrame id={fieldId} label={label} hint={hint} error={error} className={className} invalid={Boolean(error)}>
      <select id={fieldId} aria-invalid={Boolean(error) || undefined} aria-describedby={describedBy(fieldId, hint, error)} {...rest}>
        {children}
      </select>
      <span className="ui-affix" aria-hidden="true">
        ▾
      </span>
    </FieldFrame>
  );
}
