/**
 * A small set of mutually exclusive options (native radios, so arrow keys work).
 *   <Segmented label="Mode" value={mode} onChange={setMode}
 *     options={[{ value: "llm", label: "Gemma 4" }, { value: "scripted", label: "Scripted" }]} />
 * `hideLabel` keeps the label for screen readers only.
 */
import { type ReactNode, useId } from "react";

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedProps<V extends string> {
  label: ReactNode;
  value: V;
  onChange: (value: V) => void;
  options: Array<SegmentedOption<V>>;
  hideLabel?: boolean;
  disabled?: boolean;
  name?: string;
  className?: string;
}

export function Segmented<V extends string>({ label, value, onChange, options, hideLabel = false, disabled = false, name, className }: SegmentedProps<V>) {
  const autoName = useId();
  const group = name ?? autoName;
  return (
    <fieldset className={["ui-segmented", className].filter(Boolean).join(" ")} disabled={disabled}>
      <legend className={hideLabel ? "visually-hidden" : "ui-label"}>{label}</legend>
      <div className="ui-segmented-track">
        {options.map((option) => (
          <label key={option.value} title={option.title}>
            <input
              type="radio"
              name={group}
              value={option.value}
              checked={option.value === value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="ui-segmented-option">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
