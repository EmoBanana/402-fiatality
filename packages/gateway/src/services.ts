/**
 * Composition root: the real implementations behind AppContext, chosen from config.
 * src/index.ts builds the context with `createContext(config, createServices(config))`.
 * Until Phase 2 wires @p402/ai, @p402/agent, @p402/sellers and src/paypal + src/settlement here,
 * every service is the throwing stub from context.ts.
 */
import type { AppConfig } from "./config";
import type { ContextOverrides } from "./context";

export function createServices(_config: AppConfig): ContextOverrides {
  return {};
}
