/**
 * LLM_PROVIDER=mock: the reviewer judges can run without any key. Deterministic rules only (heuristics.ts), the
 * same evidence a model would get, and it says so in every explanation.
 */
import type { Repo } from '../db/repo.js';
import type { Reviewer, ReviewOutcome } from '../guard/pipeline.js';
import { gatherEvidence } from './evidence.js';
import { RECOMMENDATION_FOR_RISK } from './flags.js';
import { assessHeuristically } from './heuristics.js';
import type { PageFetcher } from './page.js';

export const MOCK_REVIEWER_LABEL = 'mock (deterministic rules, no model)';

export interface MockReviewerDeps {
  repo: Repo;
  fetchPage: PageFetcher;
}

export function createMockReviewer(deps: MockReviewerDeps): Reviewer {
  return async (input, signal): Promise<ReviewOutcome> => {
    const evidence = await gatherEvidence(deps.repo, input.request, deps.fetchPage, signal);
    const assessment = assessHeuristically(input.request, evidence);
    const explanation =
      assessment.notes.length === 0
        ? 'Mock reviewer (deterministic rules, no model): nothing suspicious. No instructions aimed at agents on the page or in the request, no owner-approval claim, the price is in line with history where there is any, and the quantity is usual.'
        : `Mock reviewer (deterministic rules, no model): ${assessment.notes.join(' ')}`;
    return { risk: assessment.risk, flags: assessment.flags, explanation, recommendation: RECOMMENDATION_FOR_RISK[assessment.risk] };
  };
}
