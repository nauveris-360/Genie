import type { Config } from '../config.js';
import type { AgentAdapter } from './AgentAdapter.js';
import { HermesAdapter } from './HermesAdapter.js';
import { MockAdapter } from './MockAdapter.js';

/**
 * Production configuration always selects Hermes (currently the honest
 * "unavailable" stub). The mock is only ever selected when a caller passes it
 * in explicitly - tests and local development - so a misconfigured deployment
 * can never silently run on fake results.
 */
export function selectAdapter(config: Config, override?: AgentAdapter): AgentAdapter {
  if (override) return override;
  if (config.hermesEnabled) return new HermesAdapter();
  return new HermesAdapter();
}

export { MockAdapter, HermesAdapter };
export type { AgentAdapter };
