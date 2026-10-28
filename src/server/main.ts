/**
 * `npm run dev`: starts the guard server (dashboard, agent API, SSE) and the synthetic shop on its own port.
 * Without PayPal credentials it runs keyless: requests are decided, nothing is charged, linking is disabled.
 * With PAYPAL_ENV set to anything but SANDBOX it refuses to start, and so it does with LLM_PROVIDER=anthropic but no key.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { loadDotEnv } from '../config/env.js';
import { openDatabase } from '../db/connection.js';
import { Repo } from '../db/repo.js';
import { seedDemo } from '../demo/seed.js';
import { PayPalExecutor } from '../guard/executor.js';
import { Guard } from '../guard/pipeline.js';
import { PayPalClient } from '../paypal/client.js';
import { loadPayPalConfig, SandboxOnlyError } from '../paypal/env.js';
import { createReviewer, loadReviewConfig, ReviewConfigError } from '../review/index.js';
import { createShopApp } from '../shop/app.js';
import { createApp } from './app.js';
import { EventBus } from './events.js';

loadDotEnv();
const env = process.env;
const host = env.HOST?.trim() || '127.0.0.1';
const port = Number(env.PORT ?? 3000);
const shopPort = Number(env.SHOP_PORT ?? 3001);
const publicBaseUrl = (env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, '');
const shopUrl = (env.SHOP_URL?.trim() || `http://localhost:${shopPort}`).replace(/\/+$/, '');
const dbPath = env.DB_PATH?.trim() || 'data/guard.db';

mkdirSync(dirname(dbPath), { recursive: true });
const repo = new Repo(openDatabase(dbPath));
if (repo.listAgents().length === 0) {
  const seeded = seedDemo(repo);
  console.log(`seeded the demo agent "${seeded.agent.id}" (synthetic) because the database had no agents`);
}

let paypal: PayPalClient | undefined;
if ((env.PAYPAL_ENV ?? '').trim() === '' && (env.PAYPAL_CLIENT_ID ?? '').trim() === '') {
  console.log('PayPal: no credentials in .env, running keyless (decisions only, no charges)');
} else {
  try {
    paypal = new PayPalClient(loadPayPalConfig(env), { log: (line) => console.log(`paypal: ${line}`) });
    console.log('PayPal: sandbox credentials present (values never printed)');
  } catch (err) {
    if (err instanceof SandboxOnlyError) {
      console.error(`refusing to start: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.log(`PayPal: ${err instanceof Error ? err.message : String(err)}; running keyless (decisions only, no charges)`);
    }
  }
}

let review: ReturnType<typeof createReviewer> | undefined;
let reviewTimeoutMs = 8_000;
if (process.exitCode !== 1) {
  try {
    const config = loadReviewConfig(env, { shopUrl });
    review = createReviewer(config, { repo, log: (line) => console.log(`reviewer: ${line}`) });
    reviewTimeoutMs = config.timeoutMs;
    console.log(`AI reviewer: ${review.label}${review.mock ? '' : ' (key present, value never printed)'}; product pages fetched only from ${config.pageOrigins.join(', ') || 'nowhere'}`);
  } catch (err) {
    if (err instanceof ReviewConfigError) {
      console.error(`refusing to start: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

if (process.exitCode !== 1 && review) {
  const events = new EventBus();
  const executor = paypal ? new PayPalExecutor({ client: paypal, repo, log: (line) => console.log(`executor: ${line}`) }) : undefined;
  const guard = new Guard({ repo, executor, reviewer: review.reviewer, reviewTimeoutMs });
  const app = createApp({ repo, guard, events, executor, paypal, publicBaseUrl, shopUrl, reviewer: { label: review.label, mock: review.mock } });
  const shop = createShopApp();

  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`guard dashboard + agent API: http://${host}:${info.port}  (database ${dbPath}; mandate ${repo.activeMandate() ? 'linked' : 'NOT linked'})`);
  });
  serve({ fetch: shop.fetch, port: shopPort, hostname: host }, (info) => {
    console.log(`synthetic shop:              http://${host}:${info.port}  (separate origin, no scripts)`);
  });
  if (host !== '127.0.0.1' && host !== 'localhost') console.log('note: the dashboard has no login; anyone who can reach this host can approve charges');
}
