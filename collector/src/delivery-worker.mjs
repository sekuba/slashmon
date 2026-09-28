import { createHash } from 'node:crypto';

import { DeliveryError } from './channels.mjs';
import { errorMessage } from './logger.mjs';
import { PollingWorker } from './polling-worker.mjs';

export const CRITICAL_DELIVERY_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const WARNING_DELIVERY_LIFETIME_MS = 24 * 60 * 60_000;

const KNOWN_CHANNEL_KINDS = new Set(['telegram', 'web_push']);

export class DeliveryWorker extends PollingWorker {
  constructor({
    repository,
    channels,
    pollIntervalMs = 1_000,
    batchSize = 50,
    concurrency = 8,
    maxAttempts = 12,
    leaseMs = 120_000,
    requestTimeoutMs = 15_000,
    maintenanceIntervalMs = 60 * 60_000,
    logger,
    now = Date.now,
  }) {
    super();
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error('Delivery concurrency must be a positive safe integer');
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error('Delivery batch size must be a positive safe integer');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new Error('Delivery request timeout must be a positive safe integer');
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < requestTimeoutMs + pollIntervalMs) {
      throw new Error('Delivery lease must cover the request timeout plus one poll interval');
    }
    this.repository = repository;
    this.channels = channels;
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maintenanceIntervalMs = maintenanceIntervalMs;
    this.logger = logger;
    this.now = now;
    this.nextMaintenanceAt = 0;
  }

  onStart() {
    this.repository.recoverStuckDeliveries(this.now() - this.leaseMs);
  }

  async runOnce() {
    this.runMaintenance(this.now());
    const result = { claimed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0 };
    while (result.claimed < this.batchSize) {
      if (!this.running && this.loopPromise) {
        break;
      }
      // Claim only work that can cross the provider boundary immediately. Once
      // this wave settles, query the priority queue again so newly arrived
      // critical alerts can jump ahead of lower-severity backlog.
      const limit = Math.min(this.concurrency, this.batchSize - result.claimed);
      const deliveries = this.repository.claimDeliveries({
        now: this.now(),
        limit,
        leaseMs: this.leaseMs,
      });
      if (deliveries.length === 0) break;
      result.claimed += deliveries.length;
      const outcomes = await Promise.all(deliveries.map((delivery) => this.deliver(delivery)));
      for (const outcome of outcomes) result[outcome] += 1;
    }
    return result;
  }

  runMaintenance(now = this.now()) {
    if (now < this.nextMaintenanceAt || !this.repository.pruneExpiredData) return undefined;
    this.nextMaintenanceAt = now + this.maintenanceIntervalMs;
    try {
      const result = this.repository.pruneExpiredData({ now });
      if (Object.values(result).some((count) => count > 0)) {
        this.logger.debug('Pruned expired notification and case history data', result);
      }
      return result;
    } catch (error) {
      // Cleanup must never stop alert delivery. Retry sooner than the normal
      // maintenance cadence, while keeping a broken database from a hot loop.
      this.nextMaintenanceAt = now + Math.min(this.maintenanceIntervalMs, 60_000);
      this.logger.warn('Retention cleanup failed', { error: errorMessage(error) });
      return undefined;
    }
  }

  async deliver(delivery) {
    // Re-check durable state immediately before the external side effect: a
    // pause, address edit, or endpoint rebind may have cancelled this row.
    if (!this.repository.isDeliverySendable(delivery.id)) {
      return 'cancelled';
    }

    const channel = this.channels[delivery.kind];
    if (!channel) {
      if (KNOWN_CHANNEL_KINDS.has(delivery.kind)) {
        return this.handleFailure(delivery, new DeliveryError(
          `Notification channel is not configured: ${delivery.kind}`,
          { scope: 'channel' },
        ));
      }
      this.repository.failDeliveryAndDisableEndpoint(
        delivery.id,
        delivery.endpointId,
        `Unsupported delivery channel: ${delivery.kind}`,
        this.now(),
      );
      return 'failed';
    }

    const controller = this.trackRequest();
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    try {
      const result = await channel.send(delivery, signal);
      const completedAt = this.now();
      this.repository.completeDelivery(delivery.id, result?.providerMessageId ?? null, completedAt);
      if (delivery.kind === 'web_push') {
        this.repository.recordSourceSuccess?.('web_push', {}, completedAt);
      }
      return 'sent';
    } catch (error) {
      if (controller.signal.aborted && !this.running) {
        this.repository.retryDelivery(delivery.id, 'Delivery interrupted during shutdown', this.now(), this.now());
        return 'retried';
      }
      if (timeoutSignal.aborted) {
        return this.handleFailure(delivery, new Error('Notification provider request timed out'));
      }
      return this.handleFailure(delivery, error);
    } finally {
      this.releaseRequest(controller);
    }
  }

  handleFailure(delivery, error) {
    const message = errorMessage(error);
    const attempts = Number(delivery.attempts ?? 1);
    const failedAt = this.now();
    const retryDeadline = deliveryRetryDeadline(delivery);
    const usefulLifetimeExpired = retryDeadline !== undefined && failedAt >= retryDeadline;
    const attemptsExhausted = retryDeadline === undefined && attempts >= this.maxAttempts;
    const requestedRetryAt = failedAt + (
      error instanceof DeliveryError && error.retryAfterMs
        ? error.retryAfterMs
        : retryDelayMs(attempts, delivery.id)
    );
    const retryAt = retryDeadline === undefined
      ? requestedRetryAt
      : Math.min(requestedRetryAt, retryDeadline);
    if (error instanceof DeliveryError && error.scope === 'channel') {
      if (usefulLifetimeExpired || attemptsExhausted) {
        this.repository.failDeliveryForChannelFailure(
          delivery.id,
          delivery.kind,
          message,
          failedAt,
        );
        this.logger.warn('Notification delivery stopped retrying during a channel outage', {
          deliveryId: delivery.id,
          kind: delivery.kind,
          attempts,
          statusCode: error.statusCode,
        });
        return 'failed';
      }
      // Channel credentials are shared by every destination. Keep urgent
      // alerts durable beyond the normal attempt ceiling and surface the
      // outage through channel health without mutating this endpoint.
      this.repository.retryDeliveryForChannelFailure(
        delivery.id,
        delivery.kind,
        message,
        retryAt,
        failedAt,
      );
      this.logger.warn('Notification channel unavailable; delivery will retry', {
        deliveryId: delivery.id,
        kind: delivery.kind,
        attempts,
        retryAt: new Date(retryAt).toISOString(),
        statusCode: error.statusCode,
      });
      return 'retried';
    }
    if ((error instanceof DeliveryError && error.permanent) || usefulLifetimeExpired || attemptsExhausted) {
      if (error instanceof DeliveryError && error.permanent) {
        this.repository.failDeliveryAndDisableEndpoint(
          delivery.id,
          delivery.endpointId,
          message,
          failedAt,
        );
      } else {
        this.repository.failDelivery(delivery.id, message, failedAt);
      }
      this.logger.warn('Notification delivery permanently failed', {
        deliveryId: delivery.id,
        kind: delivery.kind,
        attempts,
        statusCode: error?.statusCode,
      });
      return 'failed';
    }

    this.repository.retryDelivery(delivery.id, message, retryAt, failedAt);
    this.logger.warn('Notification delivery will retry', {
      deliveryId: delivery.id,
      kind: delivery.kind,
      attempts,
      retryAt: new Date(retryAt).toISOString(),
      statusCode: error?.statusCode,
    });
    return 'retried';
  }

  async runLoop() {
    while (this.running) {
      const result = await this.runOnce();
      if (result.sent || result.retried || result.failed || result.cancelled) {
        this.logger.debug('Notification outbox batch completed', result);
      }
      if (!this.running) break;
      await this.sleep(result.claimed === this.batchSize ? 0 : this.pollIntervalMs);
    }
  }

}

export function retryDelayMs(attempts, id = '') {
  const base = Math.min(6 * 60 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 12));
  const byte = createHash('sha256').update(String(id)).digest()[0];
  return base + Math.floor(base * 0.2 * (byte / 255));
}

export function deliveryRetryDeadline(delivery) {
  const lifetimeMs = deliveryLifetimeMs(delivery.event?.severity);

  if (lifetimeMs === undefined) return undefined;
  const observedAt = Number(delivery.event?.observedAt);
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return undefined;
  const deadline = observedAt + lifetimeMs;
  return Number.isSafeInteger(deadline) ? deadline : undefined;
}

function deliveryLifetimeMs(severity) {
  if (severity === 'critical') return CRITICAL_DELIVERY_LIFETIME_MS;
  if (severity === 'warning') return WARNING_DELIVERY_LIFETIME_MS;
  return undefined;
}
