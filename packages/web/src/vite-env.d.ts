/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** AG Grid / AG Charts Enterprise license (the grid works watermarked without it). */
  readonly VITE_AG_GRID_LICENSE_KEY?: string;
  /** AG Studio license. */
  readonly VITE_AG_STUDIO_LICENSE_KEY?: string;
  /** Bryntum 8 license: assign to globalThis.bryntum.licenseKey. */
  readonly VITE_BRYNTUM_LICENSE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
