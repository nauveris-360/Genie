/**
 * Hand-written shared types mirroring packages/contracts/openapi.yaml.
 * This file (plus permissions.ts) is the single source of truth consumed by
 * apps/api and, over HTTP, by the AI Studio frontend. Keep in lockstep with
 * the OpenAPI document - any shape change here must land in openapi.yaml too.
 */

export type UUID = string;
export type ISODateTime = string;

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export interface PageInfo {
  nextCursor: string | null;
}

export interface ListResponse<T> {
  data: T[];
  page: PageInfo;
}

export interface SingleResponse<T> {
  data: T;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: UUID;
  };
}

/** Canonical error codes used across the API. Keep in sync with openapi.yaml response examples. */
export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf_mismatch'
  | 'invalid_credentials'
  | 'not_found'
  | 'idempotency_key_conflict'
  | 'model_not_allowed'
  | 'approval_expired'
  | 'approval_payload_mismatch'
  | 'approval_already_decided'
  | 'task_not_cancellable'
  | 'rate_limited'
  | 'internal_error';

export interface User {
  id: UUID;
  email: string;
  displayName: string;
  createdAt: ISODateTime;
}

export interface Membership {
  id: UUID;
  tenantId: UUID;
  tenantName: string;
  role: Role;
  createdAt: ISODateTime;
}

export interface AuthMe {
  user: User;
  memberships: Membership[];
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface Tenant {
  id: UUID;
  name: string;
  slug: string;
  role: Role;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateTenantRequest {
  name: string;
}

export type WebsiteStatus = 'active' | 'archived';

export interface Website {
  id: UUID;
  tenantId: UUID;
  label: string;
  url: string;
  status: WebsiteStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateWebsiteRequest {
  label: string;
  url: string;
}

export interface UpdateWebsiteRequest {
  label?: string;
  url?: string;
  status?: WebsiteStatus;
}

export type AgentStatus = 'active' | 'disabled';

export interface Agent {
  id: UUID;
  tenantId: UUID;
  name: string;
  description: string | null;
  status: AgentStatus;
  providerConnectionId: UUID;
  modelId: string;
  requiresApproval: boolean;
  config: Record<string, unknown>;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  providerConnectionId: UUID;
  modelId: string;
  requiresApproval?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  status?: AgentStatus;
  providerConnectionId?: UUID;
  modelId?: string;
  requiresApproval?: boolean;
  config?: Record<string, unknown>;
}

export type ProviderName = 'openrouter' | 'gemini';
export type CredentialStatus = 'present' | 'missing';

export interface ProviderConnection {
  id: UUID;
  tenantId: UUID;
  provider: ProviderName;
  label: string;
  credentialStatus: CredentialStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface SaveProviderConnectionRequest {
  provider: ProviderName;
  label: string;
  /** Write-only. Never present in any response type. */
  credential: string;
}

export type PricingStatus = 'verified_free' | 'paid' | 'unknown' | 'stale';

export interface ModelUsage {
  metric: 'tokens' | 'requests';
  used: number;
  limit: number | null;
  isEstimate: boolean;
}

export interface Model {
  modelId: string;
  provider: ProviderName;
  displayName: string;
  pricingStatus: PricingStatus;
  allowed: boolean;
  inputPricePerMillionTokensUsd: number | null;
  outputPricePerMillionTokensUsd: number | null;
  lastVerifiedAt: ISODateTime | null;
  usage?: ModelUsage | null;
}

export interface ModelPolicy {
  tenantId: UUID;
  allowPaidFallback: boolean;
  updatedAt: ISODateTime;
  updatedBy: UUID | null;
}

export interface UpdateModelPolicyRequest {
  allowPaidFallback: boolean;
}

export type TaskType = 'chat' | 'summarize' | 'embed' | 'title_generate';
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled';

export interface Task {
  id: UUID;
  tenantId: UUID;
  websiteId: UUID | null;
  agentId: UUID;
  type: TaskType;
  status: TaskStatus;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  idempotencyKey: string;
  approvalId: UUID | null;
  createdBy: UUID;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CreateTaskRequest {
  agentId: UUID;
  websiteId?: UUID;
  type: TaskType;
  input: Record<string, unknown>;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: UUID;
  tenantId: UUID;
  taskId: UUID;
  action: string;
  payloadDigest: string;
  status: ApprovalStatus;
  decidedBy: UUID | null;
  decidedAt: ISODateTime | null;
  reason: string | null;
  expiresAt: ISODateTime;
  createdAt: ISODateTime;
}

export interface DecideApprovalRequest {
  decision: 'approve' | 'reject';
  reason?: string;
}

export interface AuditEvent {
  id: UUID;
  tenantId: UUID;
  actorUserId: UUID | null;
  action: string;
  targetType: string;
  targetId: UUID;
  metadata: Record<string, unknown>;
  createdAt: ISODateTime;
}

export interface ReadinessCheck {
  status: 'ok' | 'unavailable';
  detail?: string;
}

export interface ReadinessResponse {
  data: {
    status: 'ok' | 'degraded';
    checks: {
      database: ReadinessCheck;
      agentAdapter: ReadinessCheck;
    };
  };
}
