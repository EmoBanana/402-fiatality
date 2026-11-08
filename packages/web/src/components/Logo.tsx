/**
 * The 402 Fiatality lockup: the "402" monogram square followed by the wordmark "Fiatality" with "Fiat"
 * emphasized, so the pair reads "402 Fiatality" without repeating the 402. Never PayPal's logo or colors.
 *   <Logo />                     monogram + wordmark (accessible name "402 Fiatality")
 *   <Logo full />                wordmark spelled out as "402 Fiatality" (print headers, no monogram)
 *   <Monogram size={20} />       just the square
 *   <Wordmark />                 "Fiat" + "ality" in running text
 */
export const PRODUCT_NAME = "402 Fiatality";

export function Monogram({ size = 28 }: { size?: number }) {
  return (
    <span
      className="ui-monogram"
      aria-hidden="true"
      style={size === 28 ? undefined : { width: size, height: size, borderRadius: Math.round(size / 4), fontSize: Math.round(size * 0.4) }}
    >
      402
    </span>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={["ui-wordmark", className].filter(Boolean).join(" ")}>
      <b>Fiat</b>ality
    </span>
  );
}

export function Logo({ className, full = false }: { className?: string; full?: boolean }) {
  return (
    <span className={["ui-logo", className].filter(Boolean).join(" ")} aria-label={PRODUCT_NAME} role="img">
      {full ? (
        <span aria-hidden="true" className="ui-wordmark">
          402 <b>Fiat</b>ality
        </span>
      ) : (
        <>
          <Monogram />
          <span aria-hidden="true">
            <Wordmark />
          </span>
        </>
      )}
    </span>
  );
}
