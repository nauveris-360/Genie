/**
 * Verifies pricing for the approved OpenRouter models from OpenRouter's free
 * public model list and records the result in the model registry.
 *
 *   npm run models:sync -- --dry-run   # fetch + classify, print, write nothing
 *   npm run models:sync                # same, then record verifications
 *
 * Run it on a schedule well inside MODEL_PRICING_MAX_AGE_HOURS (e.g. every 6
 * hours) so verified models do not go stale. It never sends an API key and
 * never calls a model.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from '../db/index.js';
import { fetchOpenRouterModels, parseApprovedModels, syncOpenRouterPricing } from './pricingSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPROVED_PATH = path.join(__dirname, '..', '..', 'config', 'approved-models.json');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const approved = parseApprovedModels(JSON.parse(await readFile(APPROVED_PATH, 'utf8')));
  if (approved.length === 0) {
    console.log(`No approved OpenRouter models in ${APPROVED_PATH}; previously trusted rows (if any) will be demoted to unknown.`);
  }
  const feed = await fetchOpenRouterModels();
  const client = await getPool().connect();
  try {
    const results = await syncOpenRouterPricing(client, approved, feed, { dryRun });
    for (const r of results) {
      const price = r.inputPrice === null ? 'n/a' : `$${r.inputPrice}/$${r.outputPrice} per 1M tokens`;
      console.log(`${r.pricingStatus.padEnd(13)} ${r.modelId}  [${price}]  ${r.reason}`);
    }
    console.log(dryRun ? `Dry run: ${results.length} result(s), nothing written.` : `Recorded ${results.length} verification(s).`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error(`Pricing sync failed, nothing written: ${(err as Error).message}`);
  process.exitCode = 1;
});
