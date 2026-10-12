import type { TaskType } from '@genie/contracts';

/**
 * Boundary between Genie and whatever supplies reasoning (Hermes, a mock, …).
 * Everything that reaches an adapter has already passed authentication, tenant
 * membership, the free-first model policy and (where required) approval. The
 * adapter receives only tenant-scoped context: no shell, no Docker socket, no
 * administrator credentials, no cross-tenant memory, and a credential that was
 * decrypted for this one call and belongs to this one tenant.
 */
export interface AdapterSubmission {
  taskId: string;
  tenantId: string;
  agentId: string;
  type: TaskType;
  modelId: string;
  provider: 'openrouter' | 'gemini';
  /** Decrypted provider credential for this tenant only. Never logged or persisted by the adapter. */
  credential: string;
  input: Record<string, unknown>;
}

export type AdapterStatus =
  | { state: 'queued' }
  | { state: 'running' }
  | { state: 'succeeded'; result: Record<string, unknown> }
  | { state: 'failed'; error: string }
  | { state: 'cancelled' };

export interface AdapterAvailability {
  available: boolean;
  detail: string;
}

export interface AgentAdapter {
  readonly name: string;
  availability(): Promise<AdapterAvailability>;
  /** Returns an adapter-side reference used for later status/cancel calls. */
  submit(submission: AdapterSubmission): Promise<{ externalRef: string }>;
  status(externalRef: string): Promise<AdapterStatus>;
  cancel(externalRef: string): Promise<void>;
}

export class AdapterUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AdapterUnavailableError';
  }
}
