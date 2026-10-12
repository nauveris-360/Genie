import type { AdapterStatus, AdapterSubmission, AgentAdapter } from './AgentAdapter.js';

/**
 * Deterministic in-memory adapter for tests and local development. It never
 * contacts a provider, never spends money and never sees the network. It
 * records what it was given so tests can assert the boundary contract (e.g.
 * that a credential was passed for the right tenant and nothing more).
 */
export class MockAdapter implements AgentAdapter {
  readonly name = 'mock';
  readonly submissions: AdapterSubmission[] = [];
  private readonly states = new Map<string, AdapterStatus>();
  private counter = 0;

  /** Test hook: next submissions resolve to this outcome. */
  nextOutcome: 'succeed' | 'fail' | 'hang' = 'succeed';

  async availability() {
    return { available: true, detail: 'mock adapter active (no provider calls are made)' };
  }

  async submit(submission: AdapterSubmission): Promise<{ externalRef: string }> {
    this.submissions.push(submission);
    const externalRef = `mock-${++this.counter}`;
    if (this.nextOutcome === 'hang') {
      this.states.set(externalRef, { state: 'running' });
    } else if (this.nextOutcome === 'fail') {
      this.states.set(externalRef, { state: 'failed', error: 'mock adapter configured to fail' });
    } else {
      const prompt = typeof submission.input.prompt === 'string' ? submission.input.prompt : '';
      this.states.set(externalRef, {
        state: 'succeeded',
        result: { text: `[mock:${submission.modelId}] ${prompt}`.trim() },
      });
    }
    return { externalRef };
  }

  async status(externalRef: string): Promise<AdapterStatus> {
    return this.states.get(externalRef) ?? { state: 'failed', error: 'unknown external reference' };
  }

  async cancel(externalRef: string): Promise<void> {
    this.states.set(externalRef, { state: 'cancelled' });
  }
}
