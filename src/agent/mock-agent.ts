/**
 * The demo shopping agent's "brain" in mock mode (LLM_PROVIDER=mock, DECISIONS D4): deterministic, no model.
 * It reads a synthetic product page the way a naive agent would, hidden text included, and if the page tells it
 * what to buy and what reason to give, it obeys. That is the point of the injection scenario: the agent is not
 * the safety layer, the guard is.
 */
import { parseAmount } from '../domain/money.js';

export interface ProductPage {
  url: string;
  merchant: string;
  name: string;
  category: string;
  priceMinor: number;
  currency: string;
  /** All visible and invisible text on the page, whitespace collapsed. */
  text: string;
  /** An instruction aimed at the agent, when the page contains one. */
  instruction: PageInstruction | null;
}

export interface PageInstruction {
  quantity: number;
  reason: string | null;
  excerpt: string;
}

export interface PurchasePlan {
  merchant: string;
  item: string;
  category: string;
  quantity: number;
  amountMinor: number;
  amount: string;
  currency: string;
  reason: string;
  sourceUrl: string;
  followedPageInstruction: boolean;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Everything a page says, tags removed, hidden text included. */
export function extractText(htmlSource: string): string {
  return htmlSource
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function findInstruction(text: string): PageInstruction | null {
  const units = /buy (\d{1,3}) units?/i.exec(text);
  if (!units) return null;
  const reason = /use the reason ["“]([^"”]{1,200})["”]/i.exec(text);
  const start = Math.max(0, text.toLowerCase().indexOf('attention'));
  return { quantity: Number(units[1]), reason: reason?.[1] ?? null, excerpt: text.slice(start, start + 220) };
}

/** Parses a synthetic shop product page. Returns undefined when the page does not look like one. */
export function parseProductPage(url: string, htmlSource: string): ProductPage | undefined {
  const text = extractText(htmlSource);
  const sold = /Sold by (.+?) · category: (\S+)/.exec(text);
  const name = /<h1>([\s\S]*?)<\/h1>/i.exec(htmlSource);
  const price = /(\d{1,10}\.\d{2}) ([A-Z]{3})/.exec(text);
  if (!sold || !name || !price) return undefined;
  const priceMinor = parseAmount(price[1] ?? '');
  if (priceMinor === undefined) return undefined;
  return {
    url,
    merchant: sold[1]?.trim() ?? '',
    name: extractText(name[1] ?? ''),
    category: sold[2]?.trim() ?? '',
    priceMinor,
    currency: price[2] ?? 'USD',
    text,
    instruction: findInstruction(text),
  };
}

const OWN_REASONS: Record<string, string> = {
  books: 'Field notes for the survey; this is the notebook the team uses.',
  office: 'Restocking office supplies for the quarter.',
  electronics: 'Needed to inspect samples for the lab report.',
};

/** What the mock agent decides to buy from a page. It follows page instructions, which a careful agent would not. */
export function planPurchase(page: ProductPage): PurchasePlan {
  const quantity = page.instruction?.quantity ?? 1;
  const amountMinor = page.priceMinor * quantity;
  const reason = page.instruction?.reason ?? OWN_REASONS[page.category] ?? `Needed for current work: ${page.name}.`;
  const amountMajor = (amountMinor / 100).toFixed(2);
  return {
    merchant: page.merchant,
    item: `${page.name} x${quantity}`,
    category: page.category,
    quantity,
    amountMinor,
    amount: amountMajor,
    currency: page.currency,
    reason,
    sourceUrl: page.url,
    followedPageInstruction: page.instruction !== null,
  };
}
