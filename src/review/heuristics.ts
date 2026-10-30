/**
 * Deterministic checks the reviewer runs with or without a model. In mock mode they are the whole reviewer; with a
 * real model they are the floor: a flag raised here stays raised whatever the model says (D13).
 */
import { formatAmount } from '../domain/money.js';
import type { PurchaseRequest, ReviewRisk } from '../domain/types.js';
import type { ReviewEvidence } from './evidence.js';
import { type ReviewFlag, riskFromFlags } from './flags.js';
import { clampText } from './text.js';

/** Phrases that only make sense as orders to an AI agent, never as product copy. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget) (?:all |any |your |the )?(?:previous|prior|earlier|above|existing) (?:limits?|instructions?|rules?|constraints?|policy|policies)\b/i,
  /\battention,? (?:ai|llm) (?:agents?|assistants?|models?)\b/i,
  /\b(?:ai|llm) agents?[:,]? (?:must|should|are required to|have to|need to)\b/i,
  /\bdo not (?:mention|reveal|disclose|tell|report) (?:this|these|the) (?:message|instruction|text|note)s?\b/i,
  /\buse the reason\b/i,
  /\bbuy \d{1,4} units?\b/i,
  /\bsystem prompt\b/i,
  /\byou are (?:now )?(?:authori[sz]ed|allowed|permitted) to\b/i,
  /\boverride (?:your |the |all )?(?:spending )?(?:limits?|rules?|policy|budget)\b/i,
];

/** Reasons that claim an approval the agent cannot have obtained: owners approve only inside the guard. */
export const OWNER_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:pre-?)?approved by (?:the |my |your |our )?(?:owner|admin|administrator|boss|user|manager)\b/i,
  /\b(?:owner|admin|administrator|boss|user|manager) (?:has |already |has already )?(?:approved|authori[sz]ed|ok'?d|okayed|signed off|said yes|confirmed|cleared)\b/i,
  /\bauthori[sz]ed by (?:the |my |your |our )?(?:owner|admin|administrator|boss|user|manager)\b/i,
  /\bon behalf of (?:the |my )?owner\b/i,
  /\bowner(?:'s)? (?:approval|authori[sz]ation|permission|consent) (?:was |is |has been |already )?(?:given|granted|obtained|received|secured)\b/i,
];

/** A unit price at or beyond PRICE_RATIO times the history median, or at or below 1/PRICE_RATIO of it, is an anomaly (the bounds themselves count). */
export const PRICE_RATIO = 1.5;
/** A quantity this large that also exceeds twice the largest earlier quantity is unusual. */
export const QUANTITY_MIN = 5;

const EXCERPT_CHARS = 120;

/** Returns short excerpts around each instruction-like phrase found in the text. */
export function findInjectionPhrases(text: string): string[] {
  const found: string[] = [];
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 20);
    found.push(clampText(text.slice(start, start + EXCERPT_CHARS + 1), EXCERPT_CHARS)); // one extra char: a cut excerpt ends in "…"
  }
  return found;
}

export function claimsOwnerApproval(reason: string): boolean {
  return OWNER_CLAIM_PATTERNS.some((re) => re.test(reason));
}

export interface PriceAnomaly {
  medianMinor: number;
  ratio: number;
  samples: number;
}

/** Compares a unit price with the median of earlier unit prices. null when there is no history or nothing is off. */
export function priceAnomaly(unitMinor: number, historyMinor: readonly number[]): PriceAnomaly | null {
  if (historyMinor.length === 0) return null;
  const sorted = [...historyMinor].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMinor = sorted.length % 2 === 1 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
  if (medianMinor <= 0) return null;
  const ratio = unitMinor / medianMinor;
  return ratio >= PRICE_RATIO || ratio <= 1 / PRICE_RATIO ? { medianMinor, ratio, samples: sorted.length } : null;
}

export function unusualQuantity(quantity: number, historyQuantities: readonly number[]): boolean {
  if (quantity < QUANTITY_MIN) return false;
  const largest = historyQuantities.length === 0 ? 1 : Math.max(...historyQuantities);
  return quantity > 2 * largest;
}

export interface HeuristicAssessment {
  flags: ReviewFlag[];
  risk: ReviewRisk;
  /** One sentence per finding, written for the owner. */
  notes: string[];
}

export function assessHeuristically(request: PurchaseRequest, evidence: ReviewEvidence): HeuristicAssessment {
  const flags = new Set<ReviewFlag>();
  const notes: string[] = [];
  const ratioText = (ratio: number): string => (ratio >= 1 ? `${ratio.toFixed(1)}×` : `${(1 / ratio).toFixed(1)}× below`);

  const requestText = `${request.merchant} ${request.item} ${request.reason}`;
  const inRequest = findInjectionPhrases(requestText);
  if (inRequest.length > 0) {
    flags.add('PROMPT_INJECTION_SUSPECTED');
    notes.push(`The request itself reads like an injected instruction: "${inRequest[0]}".`);
  }

  if (evidence.page) {
    if (evidence.page.ok) {
      const inPage = findInjectionPhrases(evidence.page.page.text);
      if (inPage.length > 0) {
        flags.add('PROMPT_INJECTION_SUSPECTED');
        notes.push(`The product page contains text aimed at AI agents: "${inPage[0]}".`);
      }
    } else {
      flags.add('PAGE_UNAVAILABLE');
      notes.push(`The product page was not inspected (${describeProblem(evidence.page.problem, evidence.page.detail)}).`);
    }
  }

  if (claimsOwnerApproval(request.reason)) {
    flags.add('CLAIMS_OWNER_APPROVAL');
    notes.push(`The reason claims the owner already approved it ("${clampText(request.reason, 60)}"); approvals happen only inside the guard.`);
  }

  const unitPrices = evidence.history.observations.map((o) => o.unitMinor);
  const anomaly = priceAnomaly(evidence.unitMinor, unitPrices);
  if (anomaly) {
    flags.add('PRICE_ANOMALY');
    notes.push(
      `The unit price ${formatAmount(evidence.unitMinor)} ${request.currency} is ${ratioText(anomaly.ratio)} the ${formatAmount(anomaly.medianMinor)} this item cost in ${anomaly.samples} earlier accepted purchase${anomaly.samples === 1 ? '' : 's'} at this merchant.`,
    );
  }

  const quantities = evidence.history.observations.map((o) => o.quantity);
  if (unusualQuantity(evidence.item.quantity, quantities)) {
    flags.add('UNUSUAL_QUANTITY');
    notes.push(
      quantities.length === 0
        ? `${evidence.item.quantity} units at once, with no earlier purchase of this item to compare with.`
        : `${evidence.item.quantity} units at once, while earlier purchases of this item were ${Math.max(...quantities)} at most.`,
    );
  }

  const list = [...flags];
  return { flags: list, risk: riskFromFlags(list), notes };
}

function describeProblem(problem: string, detail?: string): string {
  switch (problem) {
    case 'origin_not_allowed':
      return `its origin ${detail ?? ''} is not on the guard's allowlist`.replace('  ', ' ');
    case 'redirected':
      return 'it redirects elsewhere';
    case 'http_error':
      return `the shop answered HTTP ${detail ?? '?'}`;
    case 'not_html':
      return 'it is not an HTML page';
    case 'timeout':
      return 'it took too long to load';
    case 'invalid_url':
      return 'the URL is not http(s)';
    default:
      return 'it could not be reached';
  }
}
