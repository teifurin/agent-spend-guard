/**
 * Orders v2 and Payments v2 calls the executor needs, plus the order body every charge is stamped with (DECISIONS D3).
 * Idempotency keys are derived from the guard's own request id (D8), so a retried call cannot double-charge.
 */
import { formatAmount } from '../domain/money.js';
import type { PurchaseRequest } from '../domain/types.js';
import { type PayPalClient, requestIdFor } from './client.js';

/** Orders v2 documents 127 characters for custom_id, invoice_id and description. */
export const ORDER_FIELD_MAX = 127;

export interface PayPalLink {
  rel: string;
  href: string;
  method?: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount?: { currency_code?: string; value?: string };
}

export interface PayPalOrder {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: Array<{ payments?: { captures?: PayPalCapture[] } }>;
}

export interface PayPalRefund {
  id: string;
  status: string;
}

/** What the order body needs from a request. */
export type OrderStamp = Pick<PurchaseRequest, 'id' | 'agentId' | 'merchant' | 'item' | 'amountMinor' | 'currency'>;

/** One line of printable text, trimmed to PayPal's field limit. Merchant and item are untrusted input. */
export function clampField(text: string, max: number = ORDER_FIELD_MAX): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max).trimEnd();
}

/** Deterministic per request, so an idempotent replay sends the same invoice id (D8). */
export const invoiceIdFor = (requestId: string): string => clampField(`ASG-${requestId}`);
export const customIdFor = (agentId: string, requestId: string): string => clampField(`asg:${agentId}:${requestId}`);

export const orderRequestId = (requestId: string): string => requestIdFor('order', requestId);
export const captureRequestId = (requestId: string, orderId: string): string => requestIdFor('capture', `${requestId}:${orderId}`);
export const refundRequestId = (requestId: string, captureId: string): string => requestIdFor('refund', `${requestId}:${captureId}`);

/** Orders v2 body for a charge against the owner's vaulted PayPal, buyer absent. */
export function buildVaultOrderBody(request: OrderStamp, vaultId: string): Record<string, unknown> {
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'default',
        description: clampField(`${clampField(request.merchant)}: ${clampField(request.item)}`),
        custom_id: customIdFor(request.agentId, request.id),
        invoice_id: invoiceIdFor(request.id),
        amount: { currency_code: request.currency, value: formatAmount(request.amountMinor) },
      },
    ],
    payment_source: { paypal: { vault_id: vaultId } },
  };
}

export const captureOf = (order: PayPalOrder): PayPalCapture | undefined => order.purchase_units?.[0]?.payments?.captures?.[0];

export async function createVaultOrder(client: PayPalClient, request: OrderStamp, vaultId: string): Promise<PayPalOrder> {
  const { data } = await client.request<PayPalOrder>('POST', '/v2/checkout/orders', {
    requestId: orderRequestId(request.id),
    body: buildVaultOrderBody(request, vaultId),
  });
  return data;
}

export async function getOrder(client: PayPalClient, orderId: string): Promise<PayPalOrder> {
  const { data } = await client.request<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  return data;
}

export async function captureOrder(client: PayPalClient, requestId: string, orderId: string): Promise<PayPalOrder> {
  const { data } = await client.request<PayPalOrder>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    body: {},
    requestId: captureRequestId(requestId, orderId),
  });
  return data;
}

export async function refundCapture(client: PayPalClient, requestId: string, captureId: string): Promise<PayPalRefund> {
  const { data } = await client.request<PayPalRefund>('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    body: {},
    requestId: refundRequestId(requestId, captureId),
  });
  return data;
}
