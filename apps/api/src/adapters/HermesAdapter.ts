import { AdapterUnavailableError, type AdapterStatus, type AdapterSubmission, type AgentAdapter } from './AgentAdapter.js';

export const HERMES_UNAVAILABLE_DETAIL =
  'Hermes programmatic interface not configured; set HERMES_ENABLED and verify adapter contract with Codex before enabling.';

/**
 * Placeholder for the real Hermes integration, which Codex owns. The existing
 * VPS 2 Hermes install is a standalone CLI; no supported programmatic interface
 * has been verified yet, so this adapter reports itself unavailable and
 * refuses every submission rather than inventing an endpoint or scraping
 * terminal output. Readiness surfaces this honestly as `agentAdapter:
 * unavailable`. Do not mark this as integrated until Codex has verified the
 * contract and a real implementation replaces this file.
 */
export class HermesAdapter implements AgentAdapter {
  readonly name = 'hermes';

  async availability() {
    return { available: false, detail: HERMES_UNAVAILABLE_DETAIL };
  }

  async submit(_submission: AdapterSubmission): Promise<{ externalRef: string }> {
    throw new AdapterUnavailableError(HERMES_UNAVAILABLE_DETAIL);
  }

  async status(_externalRef: string): Promise<AdapterStatus> {
    throw new AdapterUnavailableError(HERMES_UNAVAILABLE_DETAIL);
  }

  async cancel(_externalRef: string): Promise<void> {
    throw new AdapterUnavailableError(HERMES_UNAVAILABLE_DETAIL);
  }
}
