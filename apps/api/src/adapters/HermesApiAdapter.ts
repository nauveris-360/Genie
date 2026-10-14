import type { AdapterAvailability, AdapterStatus, AdapterSubmission, AgentAdapter } from './AgentAdapter.js';
import { AdapterUnavailableError } from './AgentAdapter.js';

/**
 * Constrained client for the Hermes Agent API server (the documented,
 * programmatic interface of `hermes gateway` with API_SERVER_ENABLED; see
 * docs/HERMES.md for the verification and the Hermes-side preconditions).
 *
 * Only the Runs API is used: POST /v1/runs, GET /v1/runs/{id},
 * POST /v1/runs/{id}/stop, plus GET /v1/capabilities and GET /v1/toolsets as a
 * preflight. Nothing else (no sessions, jobs, skills, browser control, model
 * routes or approvals) is ever called.
 *
 * Constraints enforced here, on top of everything TaskService checks before
 * dispatch:
 *  - Tool-free: every submission re-runs the preflight, which requires bearer
 *    auth to be on and refuses when ANY toolset is enabled for Hermes'
 *    api_server platform. A Hermes run that asks for a tool approval is stopped
 *    and failed.
 *  - One tenant: the Hermes API cannot take a per-request provider credential;
 *    a run uses the credentials configured inside Hermes. So only the single
 *    tenant named in HERMES_TENANT_ID may dispatch, and the platform's Hermes
 *    credentials never become available to other tenants. The tenant's own
 *    decrypted credential is deliberately not forwarded anywhere.
 *  - Chat only, OpenRouter only: the run pins `provider: openrouter` and the
 *    exact model that passed the free-first policy. Auxiliary task types
 *    (summarize, embed, title_generate) are not sent to Hermes.
 *  - Served model must match: a completed run must report that it was served by
 *    exactly the requested provider/model. A Hermes fallback-provider switch
 *    (or a missing report) fails the task and discards the output.
 *  - Stateless: no session id, history, previous response or memory key is
 *    sent, so each run starts a fresh Hermes session.
 *  - The API key and base URL never appear in errors, readiness details, task
 *    results or logs; redirects are refused so the key cannot be replayed to
 *    another host.
 */

export interface HermesApiOptions {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  requestTimeoutMs?: number;
  availabilityCacheMs?: number;
  fetchImpl?: typeof fetch;
}

interface HermesSettings {
  hermesBaseUrl?: string;
  hermesApiKey?: string;
  hermesTenantId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPENROUTER_PREFIX = 'openrouter/';
const REQUIRED_FEATURES = ['run_submission', 'run_status', 'run_stop'] as const;
const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_PROMPT_CHARS = 32_000;
/** Hermes' own API_SERVER_KEY startup guard requires at least 16 characters. */
const MIN_KEY_LENGTH = 16;

const PENDING = new Set(['queued', 'claimed']);
const ACTIVE = new Set(['running', 'stopping']);

/** Names of the missing or invalid Hermes settings (never their values). */
export function hermesSettingsProblems(config: HermesSettings): string[] {
  const problems: string[] = [];
  if (!config.hermesBaseUrl) problems.push('HERMES_BASE_URL is not set');
  else if (!normalizeBaseUrl(config.hermesBaseUrl)) problems.push('HERMES_BASE_URL must be an http(s) URL without credentials, query or fragment');
  if (!config.hermesApiKey) problems.push('HERMES_API_KEY is not set');
  else if (config.hermesApiKey.length < MIN_KEY_LENGTH) problems.push(`HERMES_API_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  if (!config.hermesTenantId) problems.push('HERMES_TENANT_ID is not set');
  else if (!UUID.test(config.hermesTenantId)) problems.push('HERMES_TENANT_ID must be a tenant UUID');
  return problems;
}

function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

function fail(detail: string): never {
  throw new AdapterUnavailableError(detail);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Short, single-line, control-character-free excerpt of text that came from Hermes. */
function excerpt(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : '';
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function encodeRef(runId: string, model: string): string {
  return `${runId}|${model}`;
}

function decodeRef(ref: string): { runId: string; model: string } {
  const at = ref.indexOf('|');
  const runId = at > 0 ? ref.slice(0, at) : '';
  const model = at > 0 ? ref.slice(at + 1) : '';
  if (!RUN_ID.test(runId) || !model) fail('Hermes run reference is malformed.');
  return { runId, model };
}

export class HermesApiAdapter implements AgentAdapter {
  readonly name = 'hermes';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private cached: { at: number; value: AdapterAvailability } | undefined;

  constructor(private readonly opts: HermesApiOptions) {
    const problems = hermesSettingsProblems({ hermesBaseUrl: opts.baseUrl, hermesApiKey: opts.apiKey, hermesTenantId: opts.tenantId });
    if (problems.length) throw new Error(`Invalid Hermes settings: ${problems.join('; ')}.`);
    this.baseUrl = normalizeBaseUrl(opts.baseUrl)!;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.cacheMs = opts.availabilityCacheMs ?? 30_000;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      fail('Hermes API server is unreachable.');
    }
    const text = await res.text().catch(() => '');
    if (text.length > MAX_RESPONSE_CHARS) fail('Hermes response was too large.');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  /** Returns null when Hermes is usable for tool-free runs, otherwise why not. */
  private async preflight(): Promise<string | null> {
    try {
      const caps = await this.request('GET', '/v1/capabilities');
      if (caps.status === 401 || caps.status === 403) return 'Hermes rejected the configured API key.';
      if (caps.status !== 200 || !isRecord(caps.json)) return `Hermes capabilities check failed (HTTP ${caps.status}).`;
      const auth = caps.json.auth;
      if (!isRecord(auth) || auth.required !== true) return 'Hermes API server does not require authentication; refusing to use it.';
      const features = isRecord(caps.json.features) ? caps.json.features : {};
      const missing = REQUIRED_FEATURES.filter((f) => features[f] !== true);
      if (missing.length) return `Hermes API server does not offer ${missing.join(', ')}.`;

      const tools = await this.request('GET', '/v1/toolsets');
      if (tools.status !== 200 || !Array.isArray(tools.json)) return `Hermes toolsets check failed (HTTP ${tools.status}).`;
      const enabled = tools.json
        .filter((t) => !isRecord(t) || t.enabled !== false)
        .map((t) => (isRecord(t) && typeof t.name === 'string' ? excerpt(t.name, 40) : 'unrecognised entry'));
      if (enabled.length) {
        const shown = enabled.slice(0, 10).join(', ') + (enabled.length > 10 ? ', …' : '');
        return `Hermes has toolsets enabled for its api_server platform (${shown}); Genie only dispatches tool-free chat.`;
      }
      return null;
    } catch (err) {
      return err instanceof AdapterUnavailableError ? err.message : 'Hermes preflight failed.';
    }
  }

  async availability(): Promise<AdapterAvailability> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.cacheMs) return this.cached.value;
    const problem = await this.preflight();
    const value = problem
      ? { available: false, detail: problem }
      : { available: true, detail: 'Hermes API server reachable and authenticated; no toolsets enabled (tool-free chat only).' };
    this.cached = { at: now, value };
    return value;
  }

  async submit(s: AdapterSubmission): Promise<{ externalRef: string }> {
    if (s.tenantId !== this.opts.tenantId) fail('Hermes is not enabled for this tenant.');
    if (s.type !== 'chat') fail(`Hermes is used for tool-free chat only; ${s.type} tasks are not dispatched to it.`);
    if (s.provider !== 'openrouter' || !s.modelId.startsWith(OPENROUTER_PREFIX)) fail('Hermes dispatch supports OpenRouter models only.');
    const model = s.modelId.slice(OPENROUTER_PREFIX.length);
    const keys = Object.keys(s.input);
    const prompt = s.input.prompt;
    if (keys.length !== 1 || typeof prompt !== 'string' || !prompt.trim()) fail('Hermes chat input must be exactly { "prompt": "<text>" }.');
    if (prompt.length > MAX_PROMPT_CHARS) fail(`Hermes chat prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
    // s.credential is intentionally not used: the Hermes API has no per-request credential (see class comment).

    // Fresh preflight on every dispatch: a toolset enabled since the last readiness check must still block.
    const problem = await this.preflight();
    this.cached = { at: Date.now(), value: problem ? { available: false, detail: problem } : { available: true, detail: 'Hermes API server reachable and authenticated; no toolsets enabled (tool-free chat only).' } };
    if (problem) fail(problem);

    const res = await this.request('POST', '/v1/runs', { input: prompt, model, provider: 'openrouter' }, { 'idempotency-key': `genie-task-${s.taskId}` });
    if (res.status === 401 || res.status === 403) fail('Hermes rejected the configured API key.');
    if (res.status === 429) fail('Hermes is at its concurrent-run limit; try again later.');
    if (res.status === 409) fail('Hermes refused the run: idempotency key conflict.');
    const runId = isRecord(res.json) ? res.json.run_id : undefined;
    if ((res.status !== 200 && res.status !== 202) || typeof runId !== 'string' || !RUN_ID.test(runId)) {
      fail(`Hermes refused the run (HTTP ${res.status}).`);
    }
    return { externalRef: encodeRef(runId, model) };
  }

  async status(externalRef: string): Promise<AdapterStatus> {
    const { runId, model } = decodeRef(externalRef);
    const res = await this.request('GET', `/v1/runs/${runId}`);
    if (res.status === 404) return { state: 'failed', error: 'Hermes no longer has a record of this run.' };
    if (res.status !== 200 || !isRecord(res.json)) fail(`Hermes run status check failed (HTTP ${res.status}).`);
    const run = res.json;
    const status = typeof run.status === 'string' ? run.status : '';

    if (PENDING.has(status)) return { state: 'queued' };
    if (ACTIVE.has(status)) return { state: 'running' };
    if (status === 'cancelled') return { state: 'cancelled' };
    if (status === 'failed' || status === 'interrupted') {
      const detail = excerpt(run.error);
      return { state: 'failed', error: `Hermes run ${status}${detail ? `: ${detail}` : '.'}` };
    }
    if (status === 'waiting_for_approval') {
      await this.cancel(externalRef).catch(() => undefined);
      return { state: 'failed', error: 'Hermes asked to use a tool; tool use is not permitted, so the run was stopped.' };
    }
    if (status !== 'completed') return { state: 'failed', error: `Hermes reported an unrecognised run status (${excerpt(status, 40) || 'none'}).` };

    const runtime = isRecord(run.runtime) ? run.runtime : null;
    const servedProvider = runtime && typeof runtime.provider === 'string' ? runtime.provider : '';
    const servedModel = runtime && typeof runtime.model === 'string' ? runtime.model : '';
    if (servedProvider !== 'openrouter' || servedModel !== model) {
      return {
        state: 'failed',
        error: servedProvider || servedModel
          ? `Hermes served the run with ${excerpt(servedProvider, 40)}/${excerpt(servedModel, 120)} instead of openrouter/${model}; output discarded.`
          : 'Hermes did not report which model served the run; output discarded.',
      };
    }
    if (typeof run.output !== 'string') return { state: 'failed', error: 'Hermes completed the run without text output.' };

    const result: Record<string, unknown> = { text: run.output, servedBy: { adapter: 'hermes', provider: servedProvider, model: servedModel } };
    const usage = isRecord(run.usage) ? run.usage : null;
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    if (usage) {
      // Reported by Hermes, not estimated by Genie. Key names avoid "token" so redaction keeps them.
      result.usage = { reportedBy: 'hermes', unit: 'tokens', input: count(usage.input_tokens), output: count(usage.output_tokens), total: count(usage.total_tokens) };
    }
    return { state: 'succeeded', result };
  }

  async cancel(externalRef: string): Promise<void> {
    const { runId } = decodeRef(externalRef);
    const res = await this.request('POST', `/v1/runs/${runId}/stop`);
    if (res.status === 401 || res.status === 403) fail('Hermes rejected the configured API key.');
  }
}
