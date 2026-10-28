/**
 * Picks and configures the AI reviewer from the environment (D4, D13).
 *
 *   LLM_PROVIDER=mock       deterministic rules, no key, the default
 *   LLM_PROVIDER=anthropic  Claude through the Vercel AI SDK; needs LLM_API_KEY, LLM_MODEL optional
 *
 * Misconfiguration fails closed: the server refuses to start instead of silently reviewing without a model.
 * Values are never logged; the config object holds the key only to hand it to the provider.
 */
import type { Repo } from '../db/repo.js';
import type { Reviewer } from '../guard/pipeline.js';
import { createAnthropicReviewer, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { createMockReviewer, MOCK_REVIEWER_LABEL } from './mock.js';
import { createPageFetcher, originOf } from './page.js';

export type ReviewProvider = 'mock' | 'anthropic';

export interface ReviewConfig {
  provider: ReviewProvider;
  model: string;
  apiKey: string | undefined;
  /** How long one review may take before the request is held instead. */
  timeoutMs: number;
  /** Origins the reviewer may fetch product pages from. */
  pageOrigins: string[];
}

export class ReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewConfigError';
  }
}

/** A model round trip takes longer than the rules do; both defaults can be overridden with REVIEW_TIMEOUT_MS. */
export const DEFAULT_REVIEW_TIMEOUT_MS: Record<ReviewProvider, number> = { mock: 8_000, anthropic: 30_000 };

export function loadReviewConfig(env: NodeJS.ProcessEnv = process.env, opts: { shopUrl?: string } = {}): ReviewConfig {
  const providerRaw = (env.LLM_PROVIDER ?? '').trim().toLowerCase() || 'mock';
  if (providerRaw !== 'mock' && providerRaw !== 'anthropic') {
    throw new ReviewConfigError('LLM_PROVIDER must be "mock" or "anthropic" (it is set to something else). Mock needs no key.');
  }
  const provider: ReviewProvider = providerRaw;
  const apiKey = (env.LLM_API_KEY ?? '').trim() || undefined;
  if (provider === 'anthropic' && apiKey === undefined) {
    throw new ReviewConfigError('LLM_PROVIDER=anthropic needs LLM_API_KEY in .env. Set it, or use LLM_PROVIDER=mock. Refusing to start rather than reviewing without a model.');
  }
  const model = (env.LLM_MODEL ?? '').trim() || DEFAULT_ANTHROPIC_MODEL;
  const timeoutRaw = (env.REVIEW_TIMEOUT_MS ?? '').trim();
  const timeoutMs = timeoutRaw === '' ? DEFAULT_REVIEW_TIMEOUT_MS[provider] : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new ReviewConfigError('REVIEW_TIMEOUT_MS must be a number of milliseconds, at least 1000.');

  const origins = new Set<string>();
  const shopOrigin = opts.shopUrl ? originOf(opts.shopUrl) : null;
  if (shopOrigin) origins.add(shopOrigin);
  for (const raw of (env.REVIEW_PAGE_ORIGINS ?? '').split(',')) {
    const origin = originOf(raw.trim());
    if (origin) origins.add(origin);
  }
  return { provider, model, apiKey, timeoutMs, pageOrigins: [...origins] };
}

export interface ReviewerDeps {
  repo: Repo;
  /** For tests: fetch used for product pages. */
  pageFetch?: typeof fetch;
  /** For tests: fetch handed to the LLM provider. */
  llmFetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface CreatedReviewer {
  reviewer: Reviewer;
  /** Shown on the dashboard, so nobody mistakes mock mode for a real model. */
  label: string;
  mock: boolean;
}

export function createReviewer(config: ReviewConfig, deps: ReviewerDeps): CreatedReviewer {
  const fetchPage = createPageFetcher({ allowedOrigins: config.pageOrigins, ...(deps.pageFetch ? { fetch: deps.pageFetch } : {}) });
  if (config.provider === 'mock') return { reviewer: createMockReviewer({ repo: deps.repo, fetchPage }), label: MOCK_REVIEWER_LABEL, mock: true };
  if (config.apiKey === undefined) throw new ReviewConfigError('LLM_PROVIDER=anthropic needs LLM_API_KEY.');
  const reviewer = createAnthropicReviewer({
    repo: deps.repo,
    fetchPage,
    apiKey: config.apiKey,
    model: config.model,
    ...(deps.llmFetch ? { fetch: deps.llmFetch } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  return { reviewer, label: `Anthropic ${config.model} (through the Vercel AI SDK)`, mock: false };
}

export { MOCK_REVIEWER_LABEL };
