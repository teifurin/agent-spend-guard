/**
 * What the reviewer looks at besides the request itself: the price history of the same item at the same merchant,
 * and the product page the agent read (fetched by the guard, see page.ts). Shared by the mock and the model reviewer.
 */
import type { Repo } from '../db/repo.js';
import { normalizeName } from '../domain/normalize.js';
import type { PurchaseRequest, RequestStatus } from '../domain/types.js';
import type { PageFetcher, PageResult } from './page.js';

/** Requests the rules or the owner accepted; what "this item usually costs" is based on. */
export const ACCEPTED_STATUSES: readonly RequestStatus[] = ['AUTO_APPROVED', 'APPROVED', 'PAID', 'REFUNDED'];

export interface ParsedItem {
  /** The item without its quantity suffix, e.g. "Field notebook, A5". */
  baseItem: string;
  /** normalizeName(baseItem): what history is matched on. */
  itemKey: string;
  quantity: number;
}

/** Splits "Field notebook, A5 x10" into the item and the quantity. No suffix means one unit. */
export function parseItem(item: string): ParsedItem {
  const m = /^(.*\S)\s*(?:x|×|\*)\s*(\d{1,4})\s*$/i.exec(item.trim());
  const baseItem = m?.[1] ?? item.trim();
  const quantity = m ? Math.max(1, Number(m[2])) : 1;
  return { baseItem, itemKey: normalizeName(baseItem), quantity };
}

export interface PriceObservation {
  requestId: string;
  unitMinor: number;
  quantity: number;
  createdAt: number;
}

export interface PriceHistory {
  itemKey: string;
  /** Newest first. */
  observations: PriceObservation[];
}

export interface ReviewEvidence {
  item: ParsedItem;
  /** amount / quantity, rounded to a cent. */
  unitMinor: number;
  history: PriceHistory;
  /** null when the request names no page. */
  page: PageResult | null;
}

const HISTORY_LIMIT = 20;

/** Earlier accepted purchases of the same item at the same merchant, any agent, newest first. */
export function gatherHistory(repo: Repo, request: PurchaseRequest): PriceHistory {
  const { itemKey } = parseItem(request.item);
  const rows = repo.listRequests({ merchantKey: request.merchantKey, statuses: ACCEPTED_STATUSES, limit: 200 });
  const observations: PriceObservation[] = [];
  for (const r of rows) {
    if (r.id === request.id) continue;
    const parsed = parseItem(r.item);
    if (parsed.itemKey !== itemKey) continue;
    observations.push({ requestId: r.id, unitMinor: Math.round(r.amountMinor / parsed.quantity), quantity: parsed.quantity, createdAt: r.createdAt });
    if (observations.length >= HISTORY_LIMIT) break;
  }
  return { itemKey, observations };
}

export async function gatherEvidence(repo: Repo, request: PurchaseRequest, fetchPage: PageFetcher, signal: AbortSignal): Promise<ReviewEvidence> {
  const item = parseItem(request.item);
  const history = gatherHistory(repo, request);
  const page = request.sourceUrl ? await fetchPage(request.sourceUrl, signal) : null;
  return { item, unitMinor: Math.round(request.amountMinor / item.quantity), history, page };
}
