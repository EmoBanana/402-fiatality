/**
 * Cycles the theme preference Auto -> Light -> Dark (lib/theme.ts). Icon button; the label says what the
 * current setting is and what a click does.
 *   <ThemeToggle />            <ThemeToggle withLabel />   (text next to the icon, for menus)
 */
import { type ThemePreference, useTheme } from "../lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemePreference, string> = { system: "Auto", light: "Light", dark: "Dark" };

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (preference === "dark") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" />
    </svg>
  );
}

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const { preference, setPreference } = useTheme();
  const next = NEXT[preference];
  const label = `Theme: ${LABEL[preference]}. Switch to ${LABEL[next]}.`;
  return (
    <button
      type="button"
      className={withLabel ? "ui-btn ui-btn--ghost ui-btn--sm" : "ui-btn ui-btn--ghost ui-btn--icon"}
      onClick={() => setPreference(next)}
      aria-label={label}
      title={label}
    >
      <ThemeIcon preference={preference} />
      {withLabel ? `Theme: ${LABEL[preference]}` : null}
    </button>
  );
}
