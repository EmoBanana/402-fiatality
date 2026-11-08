/**
 * Light / dark theme. Preference "system" follows prefers-color-scheme; "light"/"dark" pin it through
 * <html data-theme>, which tokens.css reads. Grids, charts and the scheduler switch their own themes from
 * `useTheme().resolved`.
 */
import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "p402.theme";
const listeners = new Set<() => void>();
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

let preference: ThemePreference = readPreference();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function apply() {
  const root = document.documentElement;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
}

function emit() {
  for (const listener of listeners) listener();
}

export function resolveTheme(pref: ThemePreference = preference): ResolvedTheme {
  if (pref !== "system") return pref;
  return media?.matches ? "dark" : "light";
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not persisted; still applied for this page
  }
  apply();
  emit();
}

/** Call once before the first render. */
export function initTheme(): void {
  apply();
  media?.addEventListener("change", emit);
}

export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme; setPreference: (p: ThemePreference) => void } {
  const resolved = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => resolveTheme(),
    () => "light" as const,
  );
  return { preference, resolved, setPreference: setThemePreference };
}
