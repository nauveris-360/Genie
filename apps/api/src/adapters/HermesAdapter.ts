import { AdapterUnavailableError, type AdapterStatus, type AdapterSubmission, type AgentAdapter } from './AgentAdapter.js';

export const HERMES_UNAVAILABLE_DETAIL =
  'Hermes programmatic interface not configured; set HERMES_ENABLED and verify adapter contract with Codex before enabling.';

/**
 * Honest "unavailable" adapter, selected whenever Hermes is not enabled or its
 * settings are incomplete. It refuses every submission rather than inventing
 * an endpoint or scraping terminal output, and readiness reports
 * `agentAdapter: unavailable` with the reason. The constrained client for the
 * documented Hermes API server is HermesApiAdapter (docs/HERMES.md); it is used
 * only when HERMES_ENABLED=true and every Hermes setting is valid.
 */
export class HermesAdapter implements AgentAdapter {
  readonly name = 'hermes';

  /** `detail` names why Hermes is unavailable (e.g. which settings are missing); never a secret value. */
  constructor(private readonly detail: string = HERMES_UNAVAILABLE_DETAIL) {}

  async availability() {
    return { available: false, detail: this.detail };
  }

  async submit(_submission: AdapterSubmission): Promise<{ externalRef: string }> {
    throw new AdapterUnavailableError(this.detail);
  }

  async status(_externalRef: string): Promise<AdapterStatus> {
    throw new AdapterUnavailableError(this.detail);
  }

  async cancel(_externalRef: string): Promise<void> {
    throw new AdapterUnavailableError(this.detail);
  }
}
