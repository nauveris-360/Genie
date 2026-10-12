import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { loadConfig } from './config.js';
import { REDACT_PATHS } from './lib/redaction.js';
import { AppError } from './lib/errors.js';
import { authPlugin } from './auth/plugin.js';
import { selectAdapter, type AgentAdapter } from './adapters/index.js';
import { TaskService } from './modules/tasks/service.js';
import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { tenantRoutes } from './modules/tenants/routes.js';
import { websiteRoutes } from './modules/websites/routes.js';
import { agentRoutes } from './modules/agents/routes.js';
import { providerRoutes } from './modules/providers/routes.js';
import { modelRoutes } from './modules/models/routes.js';
import { modelPolicyRoutes } from './modules/modelPolicy/routes.js';
import { taskRoutes } from './modules/tasks/routes.js';
import { approvalRoutes } from './modules/approvals/routes.js';
import { auditEventRoutes } from './modules/auditEvents/routes.js';

export interface BuildOptions {
  adapter?: AgentAdapter;
  logger?: boolean;
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance & { adapter: AgentAdapter }> {
  const config = loadConfig();
  const adapter = selectAdapter(config, options.adapter);
  const tasks = new TaskService(adapter);

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.nodeEnv === 'test' ? 'silent' : 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    genReqId: () => randomUUID(),
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(authPlugin);

  app.setErrorHandler((err, request, reply) => {
    const requestId = request.id;
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, requestId } });
    }
    const fastifyErr = err as { statusCode?: number; validation?: unknown };
    if (fastifyErr.validation || fastifyErr.statusCode === 400) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Request body is invalid.', requestId } });
    }
    if (fastifyErr.statusCode === 415) {
      return reply.code(415).send({ error: { code: 'validation_error', message: 'Unsupported content type.', requestId } });
    }
    request.log.error({ err, requestId }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'An unexpected error occurred.', requestId } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.', requestId: request.id } });
  });

  await app.register(
    async (v1) => {
      await v1.register(healthRoutes, { adapter });
      await v1.register(authRoutes);
      await v1.register(tenantRoutes);
      await v1.register(websiteRoutes);
      await v1.register(agentRoutes);
      await v1.register(providerRoutes);
      await v1.register(modelRoutes);
      await v1.register(modelPolicyRoutes);
      await v1.register(taskRoutes, { tasks });
      await v1.register(approvalRoutes, { tasks });
      await v1.register(auditEventRoutes);
    },
    { prefix: '/api/v1' },
  );

  return Object.assign(app, { adapter }) as FastifyInstance & { adapter: AgentAdapter };
}
