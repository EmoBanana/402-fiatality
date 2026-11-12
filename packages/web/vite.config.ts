import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

/** The root .env is shared with the gateway; only VITE_* values reach the browser. */
const envDir = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // PORT is the gateway's (the proxy target), WEB_PORT this dev server's; shell variables win over .env.
  const env = loadEnv(mode, envDir, ["PORT", "WEB_PORT"]);
  const gateway = `http://localhost:${env.PORT || "4020"}`;
  // "^/s/" is a RegExp key: a plain "/s" prefix would also capture the /sellers and /statements pages.
  const proxy: Record<string, ProxyOptions> = {
    "/api": { target: gateway },
    "^/s/": { target: gateway },
    "/paypal": { target: gateway },
    "/ws": { target: gateway, ws: true },
  };

  return {
    plugins: [react()],
    envDir,
    server: { port: Number(env.WEB_PORT) || 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: true,
      // AG Grid Enterprise, AG Studio and Bryntum are large by nature; they are split per page.
      chunkSizeWarningLimit: 6_000,
    },
  };
});
