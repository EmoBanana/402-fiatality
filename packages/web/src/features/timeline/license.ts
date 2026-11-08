/**
 * Bryntum 8 licensing: assign the key to the global `bryntum.licenseKey`, which "can be set before or after
 * Bryntum has loaded, and before or after components are created" (`interface Bryntum` in
 * @bryntum/core-enterprise/core.d.ts). Without a key the scheduler runs in trial mode with a badge.
 */
export function registerBryntumLicense(): void {
  const key = import.meta.env.VITE_BRYNTUM_LICENSE_KEY;
  if (!key) return;
  const scope = globalThis as unknown as { bryntum?: { licenseKey?: string } };
  scope.bryntum ??= {};
  scope.bryntum.licenseKey = key;
}
