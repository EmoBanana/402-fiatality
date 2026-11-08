/**
 * Button. Variants: primary (the one accent action per view), secondary, ghost, danger. Sizes: sm | md | lg.
 *   <Button variant="primary" loading={busy} onClick={approve}>Approve hold with PayPal</Button>
 *   <Link className={buttonClassName({ variant: "secondary" })} to="/terminal">View terminal</Link>
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export function buttonClassName({ variant = "secondary", size = "md", className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return ["ui-btn", `ui-btn--${variant}`, size !== "md" && `ui-btn--${size}`, className].filter(Boolean).join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "md", loading = false, icon, className, disabled, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClassName({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  );
}
