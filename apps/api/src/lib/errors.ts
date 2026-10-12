import type { ErrorCode } from '@genie/contracts';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  forbidden: 403,
  csrf_mismatch: 403,
  not_found: 404,
  idempotency_key_conflict: 409,
  model_not_allowed: 409,
  approval_expired: 409,
  approval_payload_mismatch: 409,
  approval_already_decided: 409,
  task_not_cancellable: 409,
  rate_limited: 429,
  internal_error: 500,
};

/** Error carrying a stable contract code. The message is safe to show to callers; never put internals or secrets in it. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  /** Set on 429s; sent as the Retry-After header and error.retryAfterSeconds. */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const errors = {
  validation: (message: string) => new AppError('validation_error', message),
  unauthorized: () => new AppError('unauthorized', 'Sign in to continue.'),
  invalidCredentials: () => new AppError('invalid_credentials', 'Email or password is incorrect.'),
  forbidden: () => new AppError('forbidden', 'Your role does not permit this action.'),
  csrf: () => new AppError('csrf_mismatch', 'CSRF token missing or invalid.'),
  untrustedOrigin: () => new AppError('forbidden', 'Request origin is not trusted.'),
  notFound: (what: string) => new AppError('not_found', `${what} not found.`),
  idempotencyConflict: () =>
    new AppError('idempotency_key_conflict', 'This idempotency key was already used with a different request payload.'),
  modelNotAllowed: (detail: string) => new AppError('model_not_allowed', detail),
  approvalExpired: () => new AppError('approval_expired', 'This approval expired and can no longer be decided.'),
  approvalPayloadMismatch: () =>
    new AppError('approval_payload_mismatch', "The bound action's payload changed since this approval was created."),
  approvalAlreadyDecided: () =>
    new AppError('approval_already_decided', 'This approval was already approved or rejected and cannot be changed.'),
  taskNotCancellable: (status: string) =>
    new AppError('task_not_cancellable', `Task is already ${status} and cannot be cancelled.`),
  /** Deliberately identical for per-IP and per-account limits and for unknown accounts, so it reveals nothing. */
  loginRateLimited: (retryAfterSeconds: number) =>
    new AppError('rate_limited', 'Too many sign-in attempts. Try again later.', retryAfterSeconds),
};
