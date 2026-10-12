import type { FastifyInstance } from 'fastify';
import type { ReadinessResponse } from '@genie/contracts';
import { getPool } from '../../db/index.js';
import type { AgentAdapter } from '../../adapters/AgentAdapter.js';

export async function healthRoutes(app: FastifyInstance, opts: { adapter: AgentAdapter }): Promise<void> {
  app.get('/health/live', async () => ({ data: { status: 'ok' } }));

  app.get('/health/ready', async (_request, reply) => {
    const database: ReadinessResponse['data']['checks']['database'] = await getPool()
      .query('SELECT 1')
      .then(() => ({ status: 'ok' as const }))
      .catch(() => ({ status: 'unavailable' as const, detail: 'database query failed' }));

    const availability = await opts.adapter.availability();
    const agentAdapter: ReadinessResponse['data']['checks']['agentAdapter'] = availability.available
      ? { status: 'ok', detail: availability.detail }
      : { status: 'unavailable', detail: availability.detail };

    const ok = database.status === 'ok' && agentAdapter.status === 'ok';
    const body: ReadinessResponse = { data: { status: ok ? 'ok' : 'degraded', checks: { database, agentAdapter } } };
    return reply.code(ok ? 200 : 503).send(body);
  });
}
