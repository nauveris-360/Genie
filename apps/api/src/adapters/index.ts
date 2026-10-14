import type { Config } from '../config.js';
import type { AgentAdapter } from './AgentAdapter.js';
import { HermesAdapter } from './HermesAdapter.js';
import { HermesApiAdapter, hermesSettingsProblems } from './HermesApiAdapter.js';
import { MockAdapter } from './MockAdapter.js';

/**
 * Production configuration always selects Hermes. With HERMES_ENABLED unset or
 * false, or with any Hermes setting missing or invalid, that is the honest
 * "unavailable" stub (readiness names the reason; the app still serves auth
 * and records). Only HERMES_ENABLED=true with a valid base URL, API key and
 * tenant selects the constrained API client, which still reports unavailable
 * until its preflight passes. The mock is only ever selected when a caller
 * passes it in explicitly - tests and local development - so a misconfigured
 * deployment can never silently run on fake results.
 */
export function selectAdapter(config: Config, override?: AgentAdapter): AgentAdapter {
  if (override) return override;
  if (!config.hermesEnabled) return new HermesAdapter();
  const problems = hermesSettingsProblems(config);
  if (problems.length) return new HermesAdapter(`HERMES_ENABLED=true but Hermes is not configured: ${problems.join('; ')}.`);
  return new HermesApiAdapter({ baseUrl: config.hermesBaseUrl!, apiKey: config.hermesApiKey!, tenantId: config.hermesTenantId! });
}

export { MockAdapter, HermesAdapter, HermesApiAdapter };
export type { AgentAdapter };
