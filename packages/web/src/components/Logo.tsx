/**
 * The 402 Fiatality lockup: a receipt slip (many IOU lines, one amber total: the tab's single charge) followed by
 * the name "402 Fiatality" in an arcade pixel face. Never PayPal's logo or colors.
 *   <Logo />                     slip + name (accessible name "402 Fiatality")
 *   <Logo full />                the name alone (print headers, no slip)
 *   <Monogram size={20} />       just the slip; `size` is its height
 *   <Wordmark />                 the name in running text
 */
export const PRODUCT_NAME = "402 Fiatality";

/** The slip: a title bar, three IOU lines and the amber total, above a torn edge. */
export function Monogram({ size = 28 }: { size?: number }) {
  return (
    <svg className="ui-monogram" width={(size * 26) / 32} height={size} viewBox="0 0 26 32" aria-hidden="true">
      <path
        className="ui-monogram-paper"
        d="M3 1H23a1 1 0 0 1 1 1V28L21.25 31L18.5 28L15.75 31L13 28L10.25 31L7.5 28L4.75 31L2 28V2a1 1 0 0 1 1-1Z"
      />
      <rect className="ui-monogram-title" x="6" y="5" width="9" height="3" rx="0.8" />
      <rect className="ui-monogram-line" x="6" y="11" width="14" height="1.6" rx="0.8" />
      <rect className="ui-monogram-line" x="6" y="14.5" width="11" height="1.6" rx="0.8" />
      <rect className="ui-monogram-line" x="6" y="18" width="13" height="1.6" rx="0.8" />
      <rect className="ui-monogram-total" x="6" y="22.4" width="14" height="2.8" rx="0.8" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={["ui-wordmark", className].filter(Boolean).join(" ")}>
      <span className="ui-wordmark-code">402</span> Fiatality
    </span>
  );
}

export function Logo({ className, full = false }: { className?: string; full?: boolean }) {
  return (
    <span className={["ui-logo", className].filter(Boolean).join(" ")} aria-label={PRODUCT_NAME} role="img">
      {full ? null : <Monogram />}
      <span aria-hidden="true">
        <Wordmark />
      </span>
    </span>
  );
}
