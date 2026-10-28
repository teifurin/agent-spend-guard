/**
 * Moves money for requests the guard has approved. Plan A (DECISIONS D2): every charge is an Orders v2 order
 * against the owner's vaulted PayPal (the active mandate), buyer absent; refunds go through Payments v2.
 *
 * State changes follow D10: the payment row and the request status change together, in one transaction, and
 * PayPal is only ever called outside a transaction. PayPal-side failures are recorded (PAYMENT_FAILED), not thrown;
 * programming errors (charging a request that is not approved) are thrown.
 */
import type { Repo } from '../db/repo.js';
import type { Payment } from '../domain/types.js';
import { PayPalApiError, type PayPalClient } from '../paypal/client.js';
import { captureOf, captureOrder, createVaultOrder, getOrder, type PayPalCapture, type PayPalOrder, refundCapture } from '../paypal/orders.js';

export interface ExecutorDeps {
  client: PayPalClient;
  repo: Repo;
  now?: () => number;
  /** One redacted line per step; silent by default. */
  log?: (line: string) => void;
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

const ACTOR = 'system';

export class PayPalExecutor {
  private readonly client: PayPalClient;
  private readonly repo: Repo;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(deps: ExecutorDeps) {
    this.client = deps.client;
    this.repo = deps.repo;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Charges an AUTO_APPROVED or APPROVED request through the active mandate and returns the payment,
   * COMPLETED (request PAID) or FAILED (request PAYMENT_FAILED). Safe to call again after a crash:
   * an order id already recorded is looked up instead of re-created, and idempotency keys repeat.
   */
  async charge(requestId: string): Promise<Payment> {
    const request = this.repo.getRequest(requestId);
    if (!request) throw new ExecutorError(`unknown request "${requestId}"`);
    if (request.status === 'PAID' || request.status === 'REFUNDED') {
      const done = this.repo.paymentForRequest(requestId);
      if (done) return done;
    }
    if (request.status !== 'AUTO_APPROVED' && request.status !== 'APPROVED') {
      throw new ExecutorError(`request "${requestId}" is ${request.status}; only AUTO_APPROVED or APPROVED requests can be charged`);
    }

    let payment = this.repo.beginPayment(requestId);
    if (payment.status !== 'CREATED') return payment;

    const mandate = this.repo.activeMandate();
    if (!mandate) {
      const failed = this.repo.failPayment(payment.id);
      this.audit('payment.failed', request.id, request.agentId, { paymentId: payment.id, reason: 'no active mandate: the owner has not linked PayPal' });
      return failed;
    }
    // The vault id must never reach a log or an error message, even if PayPal echoes the request body back.
    this.client.redactor.add(mandate.paypalVaultId);
    if (!payment.paypalOrderId) {
      this.audit('payment.started', request.id, request.agentId, { paymentId: payment.id, mandateId: mandate.id, amountMinor: request.amountMinor, currency: request.currency });
    }

    let orderId: string | null = payment.paypalOrderId;
    let capture: PayPalCapture | undefined;
    let failure: string | undefined;
    try {
      let order: PayPalOrder;
      if (orderId) {
        order = await getOrder(this.client, orderId); // resume: the order exists, find out how far it got
      } else {
        order = await createVaultOrder(this.client, request, mandate.paypalVaultId);
        orderId = order.id;
        payment = this.repo.updatePayment(payment.id, { paypalOrderId: order.id });
      }
      this.log(`order ${order.id} ${order.status}`);

      if (order.status === 'COMPLETED') {
        capture = captureOf(order);
        if (!capture) failure = 'order is COMPLETED but carries no capture';
      } else if (order.status === 'APPROVED' || order.status === 'CREATED') {
        const captured = await captureOrder(this.client, request.id, order.id);
        capture = captureOf(captured);
        if (!capture) failure = `capture returned ${captured.status} without a capture object`;
      } else {
        failure = `order is ${order.status}: the vaulted PayPal could not be charged with the buyer absent`;
      }
      if (capture && capture.status !== 'COMPLETED') failure = `capture ${capture.id} is ${capture.status}`;
    } catch (err) {
      failure = describe(err, this.client);
    }

    if (failure !== undefined || !capture) {
      const failed = this.repo.failPayment(payment.id, { paypalOrderId: orderId, paypalCaptureId: capture?.id ?? null });
      this.audit('payment.failed', request.id, request.agentId, {
        paymentId: payment.id,
        paypalOrderId: orderId,
        paypalCaptureId: capture?.id ?? null,
        reason: failure ?? 'no capture',
      });
      this.log(`payment ${payment.id} FAILED: ${failure ?? 'no capture'}`);
      return failed;
    }

    const settled = this.repo.settlePayment(payment.id, { paypalOrderId: orderId as string, paypalCaptureId: capture.id, capturedAt: this.now() });
    this.audit('payment.captured', request.id, request.agentId, {
      paymentId: payment.id,
      paypalOrderId: orderId,
      paypalCaptureId: capture.id,
      amountMinor: settled.amountMinor,
      currency: settled.currency,
    });
    this.log(`payment ${payment.id} COMPLETED capture ${capture.id}`);
    return settled;
  }

  /** Refunds a PAID request's capture in full and returns the payment as REFUNDED (request REFUNDED). */
  async refund(requestId: string): Promise<Payment> {
    const request = this.repo.getRequest(requestId);
    if (!request) throw new ExecutorError(`unknown request "${requestId}"`);
    const payment = this.repo.paymentForRequest(requestId);
    if (!payment) throw new ExecutorError(`request "${requestId}" has no payment`);
    if (payment.status === 'REFUNDED') return payment;
    if (payment.status !== 'COMPLETED' || !payment.paypalCaptureId) {
      throw new ExecutorError(`payment "${payment.id}" is ${payment.status}; only a completed capture can be refunded`);
    }

    let refundId: string;
    try {
      const refund = await refundCapture(this.client, request.id, payment.paypalCaptureId);
      if (refund.status !== 'COMPLETED' && refund.status !== 'PENDING') throw new ExecutorError(`refund ${refund.id} is ${refund.status}`);
      refundId = refund.id;
    } catch (err) {
      const reason = describe(err, this.client);
      this.audit('refund.failed', request.id, request.agentId, { paymentId: payment.id, paypalCaptureId: payment.paypalCaptureId, reason });
      throw err instanceof ExecutorError ? err : new ExecutorError(`refund failed: ${reason}`);
    }

    const refunded = this.repo.refundPayment(payment.id, refundId);
    this.audit('payment.refunded', request.id, request.agentId, { paymentId: payment.id, paypalCaptureId: payment.paypalCaptureId, paypalRefundId: refundId });
    this.log(`payment ${payment.id} REFUNDED refund ${refundId}`);
    return refunded;
  }

  private audit(action: string, requestId: string, agentId: string, details: Record<string, unknown>): void {
    this.repo.appendAudit({ actor: ACTOR, action, requestId, agentId, details });
  }
}

/** A short, redacted description of an error for the audit log. PayPal errors keep their name and debug id. */
function describe(err: unknown, client: PayPalClient): string {
  if (err instanceof PayPalApiError) {
    const issues = err.details.map((d) => d.issue).filter((i): i is string => typeof i === 'string');
    return client.redactor.redact(`PayPal ${err.status} ${err.paypalName}${issues.length > 0 ? ` [${issues.join(', ')}]` : ''}${err.debugId ? ` debug_id=${err.debugId}` : ''}`);
  }
  return client.redactor.redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}
