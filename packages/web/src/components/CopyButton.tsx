/**
 * Copies text to the clipboard and says so for two seconds.
 *   <CopyButton value={tab.id} label="Copy tab id" />
 */
import { useEffect, useState } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";

export interface CopyButtonProps {
  value: string;
  /** Visible text (default "Copy"). */
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

export function CopyButton({ value, label = "Copy", variant = "ghost", size = "sm", className }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const id = window.setTimeout(() => setState("idle"), 2_000);
    return () => window.clearTimeout(id);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <Button variant={variant} size={size} className={className} onClick={copy} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}
