/**
 * Moves money for requests the guard has approved. Plan A (DECISIONS D2): every charge is an Orders v2 order
 * against the owner's vaulted PayPal (the active mandate), buyer absent; refunds go through Payments v2.
 *
 * State changes follow D10: the payment row and the request status change together, in one transaction, and
 * PayPal is only ever called outside a transaction. A rejection by PayPal is recorded (PAYMENT_FAILED), not thrown.
 * An outcome PayPal never confirmed (no connection, an unreadable answer, a 5xx, a 401/403/429, a PENDING capture, any
 * error while looking a recorded order up) is left open: the payment stays CREATED, the request stays approved and the
 * amount keeps counting against the budget until the owner retries and the idempotent replay finds out what happened
 * (D16, D17). A refund PayPal answers PENDING is REFUND_PENDING, still counted, until a check confirms it (D17).
 * Programming errors are thrown.
 */
import type { Repo } from '../db/repo.js';
import type { Payment } from '../domain/types.js';
import { PayPalApiError, type PayPalClient } from '../paypal/client.js';
import { describePayPalError } from '../paypal/errors.js';
import { captureOf, captureOrder, createVaultOrder, getOrder, getRefund, type PayPalCapture, type PayPalOrder, refundCapture } from '../paypal/orders.js';

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

/** Why a charge stopped short of a capture: PayPal said no (`failed`), or nobody knows what PayPal did (`unsettled`). */
interface Stop {
  kind: 'failed' | 'unsettled';
  reason: string;
}

/**
 * Statuses that say the call did not get through, not that PayPal refused the charge: an expired or wrong token (401,
 * after the client's own retry), a permission problem (403), a timeout (408), rate limiting (429). They leave the
 * outcome open like a 5xx does, for the owner's retry (D17).
 */
const TRANSIENT_STATUSES = new Set([401, 403, 408, 429]);

/** PayPal processed the call and refused it: any other 4xx. Everything else (5xx, no connection, unreadable answer) leaves the outcome open. */
const isFinalRejection = (err: unknown): boolean => err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && !TRANSIENT_STATUSES.has(err.status);

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
   * Charges an AUTO_APPROVED or APPROVED request through the active mandate and returns the payment: COMPLETED
   * (request PAID), FAILED (request PAYMENT_FAILED), or still CREATED when PayPal never confirmed the outcome (the
   * request stays approved, see the header). Safe to call again, after a crash or as the owner's retry: an order id
   * already recorded is looked up instead of re-created, and idempotency keys repeat.
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

    const resumed = this.repo.paymentForRequest(requestId) !== undefined;
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
    if (!resumed) {
      this.audit('payment.started', request.id, request.agentId, { paymentId: payment.id, mandateId: mandate.id, amountMinor: request.amountMinor, currency: request.currency });
    }

    let orderId: string | null = payment.paypalOrderId;
    let capture: PayPalCapture | undefined;
    let stop: Stop | undefined;
    // While a recorded order is being looked up, no answer can prove that the earlier charge did not happen: an error
    // there, 4xx included, is an unknown outcome, never a rejection (D17).
    let lookingUp = false;
    try {
      let order: PayPalOrder;
      if (orderId) {
        lookingUp = true;
        order = await getOrder(this.client, orderId); // resume or retry: the order exists, find out how far it got
        lookingUp = false;
      } else {
        order = await createVaultOrder(this.client, request, mandate.paypalVaultId);
        orderId = order.id;
        payment = this.repo.updatePayment(payment.id, { paypalOrderId: order.id });
      }
      this.log(`order ${order.id} ${order.status}`);

      if (order.status === 'COMPLETED') {
        capture = captureOf(order);
        if (!capture) stop = { kind: 'unsettled', reason: 'order is COMPLETED but carries no capture object' };
      } else if (order.status === 'APPROVED' || order.status === 'CREATED') {
        const captured = await captureOrder(this.client, request.id, order.id);
        capture = captureOf(captured);
        if (!capture) stop = { kind: 'unsettled', reason: `capture returned ${captured.status} without a capture object` };
      } else {
        stop = { kind: 'failed', reason: `order is ${order.status}: the vaulted PayPal could not be charged with the buyer absent` };
      }
      if (capture && capture.status !== 'COMPLETED') {
        // DECLINED and FAILED are PayPal's final word. PENDING (or a status this code does not know) may still complete.
        const refused = capture.status === 'DECLINED' || capture.status === 'FAILED';
        stop = { kind: refused ? 'failed' : 'unsettled', reason: `capture ${capture.id} is ${capture.status}` };
      }
    } catch (err) {
      stop = { kind: !lookingUp && isFinalRejection(err) ? 'failed' : 'unsettled', reason: describePayPalError(err, this.client) };
    }
    if (stop === undefined && !capture) stop = { kind: 'unsettled', reason: 'no capture object in the answer' };

    if (stop?.kind === 'unsettled') {
      // PayPal may or may not have moved the money. Marking the payment FAILED would free the budget on a guess, so
      // it stays CREATED and the request stays approved; the owner retries from the dashboard and the replay under
      // the same idempotency keys finds out what happened without charging twice (D8, D16).
      if (capture && payment.paypalCaptureId !== capture.id) payment = this.repo.updatePayment(payment.id, { paypalCaptureId: capture.id });
      this.audit('payment.unsettled', request.id, request.agentId, { paymentId: payment.id, paypalOrderId: orderId, paypalCaptureId: capture?.id ?? null, reason: stop.reason });
      this.log(`payment ${payment.id} UNSETTLED: ${stop.reason}; the owner can retry`);
      return payment;
    }
    if (stop !== undefined || !capture) {
      const reason = stop?.reason ?? 'no capture';
      const failed = this.repo.failPayment(payment.id, { paypalOrderId: orderId, paypalCaptureId: capture?.id ?? null });
      this.audit('payment.failed', request.id, request.agentId, { paymentId: payment.id, paypalOrderId: orderId, paypalCaptureId: capture?.id ?? null, reason });
      this.log(`payment ${payment.id} FAILED: ${reason}`);
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

  /**
   * Refunds a PAID request's capture in full. Returns the payment as REFUNDED (request REFUNDED) when PayPal completes
   * the refund at once, or as REFUND_PENDING, still counted against the budget, when PayPal answers PENDING; the owner
   * then confirms it with checkRefund (D17).
   */
  async refund(requestId: string): Promise<Payment> {
    const request = this.repo.getRequest(requestId);
    if (!request) throw new ExecutorError(`unknown request "${requestId}"`);
    const payment = this.repo.paymentForRequest(requestId);
    if (!payment) throw new ExecutorError(`request "${requestId}" has no payment`);
    if (payment.status === 'REFUNDED') return payment;
    if (payment.status === 'REFUND_PENDING') {
      throw new ExecutorError(`refund ${payment.paypalRefundId ?? '?'} is still pending with PayPal; check it instead of refunding again`);
    }
    if (payment.status !== 'COMPLETED' || !payment.paypalCaptureId) {
      throw new ExecutorError(`payment "${payment.id}" is ${payment.status}; only a completed capture can be refunded`);
    }

    // A refund PayPal accepted and later cancelled has spent its idempotency key: a repeat of that key would get the
    // cancelled refund back. The next attempt carries a fresh key, numbered by the refunds PayPal accepted so far,
    // while a retry after an error that created nothing keeps the first key and is replayed safely (D8, D17).
    const attempt = this.repo.countAudit(request.id, 'refund.pending');
    let refundId: string;
    let pending: boolean;
    try {
      const refund = await refundCapture(this.client, request.id, payment.paypalCaptureId, attempt);
      if (refund.status !== 'COMPLETED' && refund.status !== 'PENDING') throw new ExecutorError(`refund ${refund.id} is ${refund.status}`);
      refundId = refund.id;
      pending = refund.status === 'PENDING';
    } catch (err) {
      const reason = describePayPalError(err, this.client);
      this.audit('refund.failed', request.id, request.agentId, { paymentId: payment.id, paypalCaptureId: payment.paypalCaptureId, reason });
      throw err instanceof ExecutorError ? err : new ExecutorError(`refund failed: ${reason}`);
    }

    if (pending) {
      const open = this.repo.markRefundPending(payment.id, refundId);
      this.audit('refund.pending', request.id, request.agentId, { paymentId: payment.id, paypalCaptureId: payment.paypalCaptureId, paypalRefundId: refundId });
      this.log(`payment ${payment.id} REFUND_PENDING refund ${refundId}: the amount stays counted until PayPal completes it`);
      return open;
    }
    return this.settleRefund(request.id, request.agentId, payment, refundId);
  }

  /**
   * Asks PayPal how a PENDING refund got on (the owner's "Check refund"). COMPLETED settles it: payment and request
   * REFUNDED, budget given back. CANCELLED or FAILED hands the capture back: COMPLETED again, refundable anew. PENDING,
   * or an error from PayPal, changes nothing (D17).
   */
  async checkRefund(requestId: string): Promise<Payment> {
    const request = this.repo.getRequest(requestId);
    if (!request) throw new ExecutorError(`unknown request "${requestId}"`);
    const payment = this.repo.paymentForRequest(requestId);
    if (!payment) throw new ExecutorError(`request "${requestId}" has no payment`);
    if (payment.status === 'REFUNDED') return payment;
    if (payment.status !== 'REFUND_PENDING' || !payment.paypalRefundId) {
      throw new ExecutorError(`payment "${payment.id}" is ${payment.status}; only a pending refund can be checked`);
    }

    let status: string;
    try {
      status = (await getRefund(this.client, payment.paypalRefundId)).status;
    } catch (err) {
      throw new ExecutorError(`could not check refund ${payment.paypalRefundId}: ${describePayPalError(err, this.client)}`);
    }
    this.log(`refund ${payment.paypalRefundId} ${status}`);
    if (status === 'COMPLETED') return this.settleRefund(request.id, request.agentId, payment, payment.paypalRefundId);
    if (status === 'CANCELLED' || status === 'FAILED') {
      const restored = this.repo.cancelPendingRefund(payment.id);
      this.audit('refund.failed', request.id, request.agentId, { paymentId: payment.id, paypalCaptureId: payment.paypalCaptureId, paypalRefundId: payment.paypalRefundId, reason: `refund ${payment.paypalRefundId} is ${status}` });
      this.log(`payment ${payment.id} back to COMPLETED: refund ${payment.paypalRefundId} ${status}`);
      return restored;
    }
    return payment; // PENDING, or a status this code does not know: nothing to book yet
  }

  private settleRefund(requestId: string, agentId: string, payment: Payment, refundId: string): Payment {
    const refunded = this.repo.refundPayment(payment.id, refundId);
    this.audit('payment.refunded', requestId, agentId, { paymentId: payment.id, paypalCaptureId: payment.paypalCaptureId, paypalRefundId: refundId });
    this.log(`payment ${payment.id} REFUNDED refund ${refundId}`);
    return refunded;
  }

  private audit(action: string, requestId: string, agentId: string, details: Record<string, unknown>): void {
    this.repo.appendAudit({ actor: ACTOR, action, requestId, agentId, details });
  }
}
