/**
 * The 402 Fiatality lockup: a small segment display reading 4:02 (HTTP 402, read as a clock) followed by the
 * wordmark in segment letters, like the readout of a digital clock. Never PayPal's logo or colors.
 *   <Logo />                     display + wordmark (accessible name "402 Fiatality")
 *   <Logo full />                wordmark spelled out as "402 Fiatality" (print headers, no display)
 *   <Monogram size={20} />       just the 4:02 display
 *   <Wordmark />                 the wordmark in running text
 */
export const PRODUCT_NAME = "402 Fiatality";

/** "4:02" lit over a faint "8:88", so the unlit segments show the way they do on a real clock. */
export function Monogram({ size = 28 }: { size?: number }) {
  return (
    <span className="ui-monogram" aria-hidden="true" style={size === 28 ? undefined : { fontSize: size / 2 }}>
      <span className="ui-monogram-ghost">8:88</span>
      <span className="ui-monogram-lit">
        4<span className="ui-monogram-colon">:</span>02
      </span>
    </span>
  );
}

/**
 * FIATALITY in segment letters (a 12 x 20 cell per letter), drawn as strokes rather than set in a segment font so
 * every letter, the Y included, reads at full height.
 */
const WORDMARK = "M2.3 1.2L9.7 1.2M1.2 2.4L1.2 8.8M1.2 11.2L1.2 17.6M2.3 10L7.4 10M19.3 1.2L26.7 1.2M19.3 18.8L26.7 18.8M23 2.6L23 8.8M23 11L23 17.4M36.3 1.2L43.7 1.2M35.2 2.4L35.2 8.8M44.8 2.4L44.8 8.8M36.3 10L43.7 10M35.2 11.2L35.2 17.6M44.8 11.2L44.8 17.6M53.3 1.2L60.7 1.2M57 2.6L57 8.8M57 11L57 17.4M70.3 1.2L77.7 1.2M69.2 2.4L69.2 8.8M78.8 2.4L78.8 8.8M70.3 10L77.7 10M69.2 11.2L69.2 17.6M78.8 11.2L78.8 17.6M86.2 2.4L86.2 8.8M86.2 11.2L86.2 17.6M87.3 18.8L94.7 18.8M104.3 1.2L111.7 1.2M104.3 18.8L111.7 18.8M108 2.6L108 8.8M108 11L108 17.4M121.3 1.2L128.7 1.2M125 2.6L125 8.8M125 11L125 17.4M138.2 2.4L141.1 9M145.8 2.4L142.9 9M142 11L142 17.4";

export function Wordmark({ className }: { className?: string }) {
  return (
    <svg className={["ui-wordmark", className].filter(Boolean).join(" ")} viewBox="0 0 148 20" aria-hidden="true">
      <path d={WORDMARK} />
    </svg>
  );
}

export function Logo({ className, full = false }: { className?: string; full?: boolean }) {
  return (
    <span className={["ui-logo", className].filter(Boolean).join(" ")} aria-label={PRODUCT_NAME} role="img">
      {full ? (
        <span aria-hidden="true" className="ui-logo-full">
          <span className="ui-logo-402">402</span>
          <Wordmark />
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
