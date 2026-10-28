/**
 * Payment Method Tokens v3: the owner's one-time mandate (DECISIONS D2).
 * setup token -> owner approves on PayPal's page -> payment token (vault_id), which the executor charges later.
 */
import { type PayPalClient, requestIdFor } from './client.js';

export const MANDATE_DESCRIPTION = 'agent-spend-guard: one-time mandate letting the guard charge policy-approved agent purchases (sandbox demo)';

interface Link {
  rel: string;
  href: string;
  method?: string;
}

interface SetupTokenResponse {
  id: string;
  status: string;
  links?: Link[];
}

interface PaymentTokenResponse {
  id: string;
  customer?: { id?: string };
}

export interface SetupTokenResult {
  id: string;
  status: string;
  approveUrl: string | undefined;
}

export interface PaymentTokenResult {
  vaultId: string;
  customerId: string | null;
}

export interface SetupTokenOptions {
  returnUrl: string;
  cancelUrl: string;
  /** Idempotency key for this link attempt. */
  key: string;
  brandName?: string;
}

export async function createSetupToken(client: PayPalClient, opts: SetupTokenOptions): Promise<SetupTokenResult> {
  const { data } = await client.request<SetupTokenResponse>('POST', '/v3/vault/setup-tokens', {
    requestId: requestIdFor('setup-token', opts.key),
    body: {
      payment_source: {
        paypal: {
          description: MANDATE_DESCRIPTION,
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          usage_pattern: 'IMMEDIATE',
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: opts.brandName ?? 'agent-spend-guard (sandbox)',
            locale: 'en-US',
            shipping_preference: 'NO_SHIPPING',
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            return_url: opts.returnUrl,
            cancel_url: opts.cancelUrl,
          },
        },
      },
    },
  });
  return { id: data.id, status: data.status, approveUrl: data.links?.find((l) => l.rel === 'approve')?.href };
}

export async function getSetupToken(client: PayPalClient, id: string): Promise<{ id: string; status: string }> {
  const { data } = await client.request<SetupTokenResponse>('GET', `/v3/vault/setup-tokens/${encodeURIComponent(id)}`);
  return { id: data.id, status: data.status };
}

/** Exchanges an APPROVED setup token for the long-lived payment token. The result is sensitive: store it, never log it. */
export async function createPaymentToken(client: PayPalClient, setupTokenId: string, key: string): Promise<PaymentTokenResult> {
  const { data } = await client.request<PaymentTokenResponse>('POST', '/v3/vault/payment-tokens', {
    requestId: requestIdFor('payment-token', key),
    body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
  });
  client.redactor.add(data.id);
  return { vaultId: data.id, customerId: data.customer?.id ?? null };
}
