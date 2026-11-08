/**
 * Design tokens (styles/tokens.css) resolved to literal values for libraries that theme in JS: AG Charts
 * draws on a canvas and AG Studio builds its theme from params, so neither can follow CSS variables on its
 * own. `useTokens()` re-reads them whenever the resolved light/dark theme changes.
 */
import { useMemo } from "react";
import { type ResolvedTheme, useTheme } from "../../lib/theme";

export interface Tokens {
  mode: ResolvedTheme;
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  ink2: string;
  muted: string;
  hairline: string;
  hairlineStrong: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  success: string;
  danger: string;
  warning: string;
  /** --series-1..6, in order. Assign by entity (never by rank) so a series keeps its color. */
  series: string[];
  fontSans: string;
  fontMono: string;
}

const FALLBACK_SERIES = ["#1d3a6e", "#0f766e", "#a15c07", "#6d28d9", "#be185d", "#4d7c0f"];

export function readTokens(mode: ResolvedTheme): Tokens {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(`--${name}`).trim() || fallback;
  return {
    mode,
    bg: v("bg", "#fafaf8"),
    surface: v("surface", "#ffffff"),
    surface2: v("surface-2", "#f4f4f2"),
    ink: v("ink", "#0e0e10"),
    ink2: v("ink-2", "#3f3f46"),
    muted: v("muted", "#71717a"),
    hairline: v("hairline", "#e7e5e4"),
    hairlineStrong: v("hairline-strong", "#d6d3d1"),
    accent: v("accent", "#1d3a6e"),
    accentSoft: v("accent-soft", "#eef2f9"),
    onAccent: v("on-accent", "#ffffff"),
    success: v("success", "#15803d"),
    danger: v("danger", "#b42318"),
    warning: v("warning", "#b54708"),
    series: FALLBACK_SERIES.map((fallback, i) => v(`series-${i + 1}`, fallback)),
    fontSans: v("font-sans", "Inter Variable, ui-sans-serif, system-ui, sans-serif"),
    fontMono: v("font-mono", "JetBrains Mono Variable, ui-monospace, monospace"),
  };
}

export function useTokens(): Tokens {
  const { resolved } = useTheme();
  return useMemo(() => readTokens(resolved), [resolved]);
}
