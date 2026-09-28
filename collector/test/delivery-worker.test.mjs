import assert from 'node:assert/strict';
import test from 'node:test';

import { DeliveryError } from '../src/channels.mjs';
import {
  CRITICAL_DELIVERY_LIFETIME_MS,
  WARNING_DELIVERY_LIFETIME_MS,
  DeliveryWorker,
  retryDelayMs,
} from '../src/delivery-worker.mjs';
import { silentLogger } from './helpers.mjs';

const DELIVERY = {
  id: 'delivery-1',
  endpointId: 'endpoint-1',
  kind: 'web_push',
  attempts: 1,
};

test('DeliveryWorker completes accepted outbox deliveries', async () => {
  const repository = fakeRepository();
  const worker = createWorker(repository, {
    async send(delivery, signal) {
      assert.equal(delivery, DELIVERY);
      assert.equal(signal.aborted, false);
      return { providerMessageId: 'provider-42' };
    },
  });

  assert.equal(await worker.deliver(DELIVERY), 'sent');
  assert.deepEqual(repository.calls, [
    ['complete', 'delivery-1', 'provider-42', 10_000],
  ]);
});

test('DeliveryWorker clears shared Web Push channel failure state after an accepted send', async () => {
  const repository = fakeRepository();
  repository.recordSourceSuccess = (...args) => repository.calls.push(['source-success', ...args]);
  const worker = createWorker(repository, {
    async send() {
      return { providerMessageId: 'provider-43' };
    },
  });

  assert.equal(await worker.deliver(DELIVERY), 'sent');
  assert.deepEqual(repository.calls, [
    ['complete', 'delivery-1', 'provider-43', 10_000],
    ['source-success', 'web_push', {}, 10_000],
  ]);
});

test('DeliveryWorker rejects an invalid concurrency limit', () => {
  assert.throws(() => new DeliveryWorker({
    repository: fakeRepository(),
    channels: {},
    concurrency: 0,
    logger: silentLogger,
  }), /positive safe integer/);
  assert.throws(() => new DeliveryWorker({
    repository: fakeRepository(),
    channels: {},
    pollIntervalMs: 1_000,
    leaseMs: 10_000,
    requestTimeoutMs: 9_001,
    logger: silentLogger,
  }), /cover the request timeout plus one poll interval/);
});

test('DeliveryWorker respects provider retry_after without disabling the endpoint', async () => {
  const repository = fakeRepository();
  const worker = createWorker(repository, {
    async send() {
      throw new DeliveryError('slow down', { retryAfterMs: 7_000, statusCode: 429 });
    },
  });

  assert.equal(await worker.deliver(DELIVERY), 'retried');
  assert.deepEqual(repository.calls, [
    ['retry', 'delivery-1', 'slow down', 17_000, 10_000],
  ]);
});

test('DeliveryWorker bounds provider calls independently of channel implementations', async () => {
  const repository = fakeRepository();
  const worker = createWorker(repository, {
    async send(_delivery, signal) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  }, {
    requestTimeoutMs: 5,
    leaseMs: 2_000,
  });

  assert.equal(await worker.deliver(DELIVERY), 'retried');
  assert.deepEqual(repository.calls, [[
    'retry',
    'delivery-1',
    'Notification provider request timed out',
    10_000 + retryDelayMs(1, DELIVERY.id),
    10_000,
  ]]);
});

test('DeliveryWorker permanently fails and disables an expired endpoint', async () => {
  const repository = fakeRepository();
  const worker = createWorker(repository, {
    async send() {
      throw new DeliveryError('Web Push returned HTTP 410', { permanent: true, statusCode: 410 });
    },
  });

  assert.equal(await worker.deliver(DELIVERY), 'failed');
  assert.deepEqual(repository.calls, [
    ['fail-disable', 'delivery-1', 'endpoint-1', 'Web Push returned HTTP 410', 10_000],
  ]);
});

test('DeliveryWorker keeps Telegram auth failures retryable without disabling chats', async () => {
  const repository = fakeRepository();
  const channel = {
    async send() {
      throw new DeliveryError('Telegram sendMessage returned error 401', {
        permanent: true,
        scope: 'channel',
        statusCode: 401,
      });
    },
  };
  const worker = createWorker(repository, channel, {
    channels: { telegram: channel },
    maxAttempts: 3,
  });
  const delivery = {
    ...DELIVERY,
    kind: 'telegram',
    attempts: 3,
    event: { severity: 'critical', observedAt: 0 },
  };

  assert.equal(await worker.deliver(delivery), 'retried');
  const expectedRetryAt = 10_000 + retryDelayMs(3, delivery.id);
  assert.deepEqual(repository.calls, [
    [
      'channel-retry',
      'delivery-1',
      'telegram',
      'Telegram sendMessage returned error 401',
      expectedRetryAt,
      10_000,
    ],
  ]);

  const expiredRepository = fakeRepository();
  const expiredWorker = createWorker(expiredRepository, channel, {
    channels: { telegram: channel },
    maxAttempts: 3,
    now: () => CRITICAL_DELIVERY_LIFETIME_MS,
  });
  assert.equal(await expiredWorker.deliver(delivery), 'failed');
  assert.deepEqual(expiredRepository.calls, [[
    'channel-fail',
    'delivery-1',
    'telegram',
    'Telegram sendMessage returned error 401',
    CRITICAL_DELIVERY_LIFETIME_MS,
  ]]);
});

test('DeliveryWorker caps channel-outage retries for info and test traffic', async () => {
  const repository = fakeRepository();
  const channel = {
    async send() {
      throw new DeliveryError('Telegram sendMessage returned error 401', {
        permanent: true,
        scope: 'channel',
        statusCode: 401,
      });
    },
  };
  const worker = createWorker(repository, channel, {
    channels: { telegram: channel },
    maxAttempts: 3,
  });
  const delivery = {
    ...DELIVERY,
    kind: 'telegram',
    attempts: 3,
    event: { severity: 'info', observedAt: 0 },
  };

  assert.equal(await worker.deliver(delivery), 'failed');
  assert.deepEqual(repository.calls, [[
    'channel-fail',
    'delivery-1',
    'telegram',
    'Telegram sendMessage returned error 401',
    10_000,
  ]]);
});

test('DeliveryWorker exhausts retry attempts without disabling a healthy endpoint', async () => {
  const repository = fakeRepository();
  const worker = createWorker(repository, {
    async send() {
      throw new Error('provider stayed unavailable');
    },
  }, { maxAttempts: 3 });

  assert.equal(await worker.deliver({ ...DELIVERY, attempts: 3 }), 'failed');
  assert.deepEqual(repository.calls, [
    ['fail', 'delivery-1', 'provider stayed unavailable', 10_000],
  ]);
});

test('DeliveryWorker keeps urgent alerts retryable until their severity lifetime expires', async () => {
  for (const [severity, lifetimeMs] of [
    ['critical', CRITICAL_DELIVERY_LIFETIME_MS],
    ['warning', WARNING_DELIVERY_LIFETIME_MS],
  ]) {
    const beforeDeadline = lifetimeMs - 1_000;
    const retryRepository = fakeRepository();
    const retryWorker = createWorker(retryRepository, {
      async send() {
        throw new Error('provider stayed unavailable');
      },
    }, { maxAttempts: 3, now: () => beforeDeadline });
    const delivery = {
      ...DELIVERY,
      attempts: 99,
      event: { severity, observedAt: 0 },
    };

    assert.equal(await retryWorker.deliver(delivery), 'retried');
    assert.deepEqual(retryRepository.calls, [[
      'retry',
      'delivery-1',
      'provider stayed unavailable',
      lifetimeMs,
      beforeDeadline,
    ]]);

    const expiredRepository = fakeRepository();
    const expiredWorker = createWorker(expiredRepository, {
      async send() {
        throw new Error('provider stayed unavailable');
      },
    }, { maxAttempts: 3, now: () => lifetimeMs });
    assert.equal(await expiredWorker.deliver(delivery), 'failed');
    assert.deepEqual(expiredRepository.calls, [[
      'fail',
      'delivery-1',
      'provider stayed unavailable',
      lifetimeMs,
    ]]);
  }
});

test('DeliveryWorker disables endpoints with unsupported stored channel kinds', async () => {
  const repository = fakeRepository();
  const worker = new DeliveryWorker({
    repository,
    channels: {},
    logger: silentLogger,
    now: () => 10_000,
  });

  assert.equal(await worker.deliver({ ...DELIVERY, kind: 'carrier_pigeon' }), 'failed');
  assert.deepEqual(repository.calls, [
    ['fail-disable', 'delivery-1', 'endpoint-1', 'Unsupported delivery channel: carrier_pigeon', 10_000],
  ]);
});

test('DeliveryWorker treats omitted known-channel config as an outage without disabling endpoints', async () => {
  const urgentRepository = fakeRepository();
  const worker = new DeliveryWorker({
    repository: urgentRepository,
    channels: {},
    maxAttempts: 3,
    logger: silentLogger,
    now: () => 10_000,
  });
  const urgent = {
    ...DELIVERY,
    kind: 'telegram',
    attempts: 99,
    event: { severity: 'critical', observedAt: 0 },
  };

  assert.equal(await worker.deliver(urgent), 'retried');
  assert.deepEqual(urgentRepository.calls, [[
    'channel-retry',
    'delivery-1',
    'telegram',
    'Notification channel is not configured: telegram',
    10_000 + retryDelayMs(99, urgent.id),
    10_000,
  ]]);

  const infoRepository = fakeRepository();
  const infoWorker = new DeliveryWorker({
    repository: infoRepository,
    channels: {},
    maxAttempts: 3,
    logger: silentLogger,
    now: () => 10_000,
  });
  assert.equal(await infoWorker.deliver({
    ...DELIVERY,
    kind: 'web_push',
    attempts: 3,
    event: { severity: 'info', observedAt: 0 },
  }), 'failed');
  assert.deepEqual(infoRepository.calls, [[
    'channel-fail',
    'delivery-1',
    'web_push',
    'Notification channel is not configured: web_push',
    10_000,
  ]]);
});

test('DeliveryWorker summarizes a claimed outbox batch', async () => {
  const repository = fakeRepository([
    DELIVERY,
    { ...DELIVERY, id: 'delivery-2', endpointId: 'endpoint-2' },
  ]);
  let count = 0;
  const worker = createWorker(repository, {
    async send() {
      count += 1;
      if (count === 2) throw new DeliveryError('gone', { permanent: true, statusCode: 410 });
      return { providerMessageId: 'ok' };
    },
  });

  assert.deepEqual(await worker.runOnce(), {
    claimed: 2,
    sent: 1,
    retried: 0,
    failed: 1,
    cancelled: 0,
  });
  assert.deepEqual(repository.claimOptionsHistory, [
    { now: 10_000, limit: 8, leaseMs: 120_000 },
    { now: 10_000, limit: 8, leaseMs: 120_000 },
  ]);
});

test('DeliveryWorker sends a claimed batch with bounded parallelism', async () => {
  const deliveries = Array.from({ length: 7 }, (_, index) => ({
    ...DELIVERY,
    id: `delivery-${index + 1}`,
    endpointId: `endpoint-${index + 1}`,
  }));
  const repository = fakeRepository(deliveries);
  let active = 0;
  let maximumActive = 0;
  const worker = createWorker(repository, {
    async send() {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { providerMessageId: 'ok' };
    },
  }, { concurrency: 3 });

  assert.deepEqual(await worker.runOnce(), {
    claimed: 7,
    sent: 7,
    retried: 0,
    failed: 0,
    cancelled: 0,
  });
  assert.equal(maximumActive, 3);
  assert.deepEqual(repository.claimOptionsHistory.map(({ limit }) => limit), [3, 3, 3, 3]);
});

test('DeliveryWorker aborts every active send without preclaiming later waves', async () => {
  const deliveries = Array.from({ length: 5 }, (_, index) => ({
    ...DELIVERY,
    id: `delivery-${index + 1}`,
    endpointId: `endpoint-${index + 1}`,
  }));
  const repository = fakeRepository(deliveries);
  let started = 0;
  let resolveStarted;
  const activeWaveStarted = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const worker = createWorker(repository, {
    async send(_delivery, signal) {
      started += 1;
      if (started === 2) resolveStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  }, { concurrency: 2 });

  worker.start();
  await activeWaveStarted;
  await worker.stop();

  assert.equal(started, 2);
  assert.deepEqual(
    repository.calls.filter(([action]) => action === 'retry').map(([, id]) => id).sort(),
    ['delivery-1', 'delivery-2'],
  );
  assert.deepEqual(
    repository.calls.filter(([action]) => action === 'release'),
    [],
  );
  assert.equal(repository.claimOptionsHistory.length, 1);
});

test('DeliveryWorker refreshes priority between waves', async () => {
  const lowPriority = Array.from({ length: 3 }, (_, index) => ({
    ...DELIVERY,
    id: `info-${index + 1}`,
    endpointId: `endpoint-${index + 1}`,
    event: { severity: 'info', observedAt: 0 },
  }));
  const critical = {
    ...DELIVERY,
    id: 'critical-new',
    endpointId: 'endpoint-critical',
    event: { severity: 'critical', observedAt: 1 },
  };
  const repository = fakeRepository(lowPriority);
  const sent = [];
  const worker = createWorker(repository, {
    async send(delivery) {
      sent.push(delivery.id);
      if (delivery.id === 'info-1') repository.enqueueFront(critical);
      return { providerMessageId: 'ok' };
    },
  }, { concurrency: 2, batchSize: 3 });

  assert.deepEqual(await worker.runOnce(), {
    claimed: 3,
    sent: 3,
    retried: 0,
    failed: 0,
    cancelled: 0,
  });
  assert.deepEqual(sent, ['info-1', 'info-2', 'critical-new']);
  assert.deepEqual(repository.claimOptionsHistory.map(({ limit }) => limit), [2, 1]);
});

test('DeliveryWorker leases each wave only when it is ready to send', async () => {
  const deliveries = Array.from({ length: 3 }, (_, index) => ({
    ...DELIVERY,
    id: `delivery-${index + 1}`,
    endpointId: `endpoint-${index + 1}`,
  }));
  const repository = fakeRepository(deliveries);
  let now = 0;
  const starts = [];
  const worker = createWorker(repository, {
    async send(delivery) {
      starts.push([delivery.id, now]);
      now += 100_000;
      return { providerMessageId: 'ok' };
    },
  }, {
    batchSize: 3,
    concurrency: 1,
    now: () => now,
  });

  assert.equal((await worker.runOnce()).sent, 3);
  assert.deepEqual(starts, [
    ['delivery-1', 0],
    ['delivery-2', 100_000],
    ['delivery-3', 200_000],
  ]);
  assert.deepEqual(repository.claimOptionsHistory.map(({ now: claimedAt, limit }) => [claimedAt, limit]), [
    [0, 1],
    [100_000, 1],
    [200_000, 1],
  ]);
});

test('DeliveryWorker rechecks durable state before crossing a provider boundary', async () => {
  const repository = fakeRepository();
  repository.isDeliverySendable = () => false;
  let sends = 0;
  const worker = createWorker(repository, {
    async send() {
      sends += 1;
    },
  });

  assert.equal(await worker.deliver(DELIVERY), 'cancelled');
  assert.equal(sends, 0);
  assert.deepEqual(repository.calls, []);
});

test('DeliveryWorker does not claim work after shutdown begins', async () => {
  const repository = fakeRepository([
    DELIVERY,
    { ...DELIVERY, id: 'delivery-2' },
  ]);
  const worker = createWorker(repository, { async send() {} });
  worker.running = false;
  worker.loopPromise = Promise.resolve();

  assert.deepEqual(await worker.runOnce(), {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    cancelled: 0,
  });
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(repository.claimOptionsHistory, []);
});

test('DeliveryWorker runs bounded journal maintenance once per interval', async () => {
  let now = 10_000;
  const repository = fakeRepository();
  const maintenance = [];
  repository.pruneExpiredData = (options) => {
    maintenance.push(options);
    return { testEvents: 0, terminalDeliveries: 0, telegramTokens: 0 };
  };
  const worker = new DeliveryWorker({
    repository,
    channels: {},
    maintenanceIntervalMs: 100,
    logger: silentLogger,
    now: () => now,
  });

  await worker.runOnce();
  now = 10_099;
  await worker.runOnce();
  now = 10_100;
  await worker.runOnce();
  assert.deepEqual(maintenance, [{ now: 10_000 }, { now: 10_100 }]);
});

test('retryDelayMs is deterministic, bounded, and grows exponentially', () => {
  const first = retryDelayMs(1, 'delivery-1');
  const same = retryDelayMs(1, 'delivery-1');
  const second = retryDelayMs(2, 'delivery-1');

  assert.equal(first, same);
  assert.ok(first >= 5_000 && first < 6_000);
  assert.ok(second >= 10_000 && second < 12_000);
  const maximum = retryDelayMs(100, 'delivery-1');
  assert.equal(maximum, retryDelayMs(13, 'delivery-1'));
  assert.ok(maximum >= 5_000 * 2 ** 12);
  assert.ok(maximum < 5_000 * 2 ** 12 * 1.2);
});

function createWorker(repository, channel, overrides = {}) {
  return new DeliveryWorker({
    repository,
    channels: { web_push: channel },
    logger: silentLogger,
    now: () => 10_000,
    ...overrides,
  });
}

function fakeRepository(deliveries = []) {
  const queued = [...deliveries];
  return {
    calls: [],
    claimOptions: undefined,
    claimOptionsHistory: [],
    claimDeliveries(options) {
      this.claimOptions = options;
      this.claimOptionsHistory.push({ ...options });
      return queued.splice(0, options.limit);
    },
    enqueueFront(delivery) {
      queued.unshift(delivery);
    },
    recoverStuckDeliveries() {},
    isDeliverySendable() {
      return true;
    },
    completeDelivery(...args) {
      this.calls.push(['complete', ...args]);
    },
    retryDelivery(...args) {
      this.calls.push(['retry', ...args]);
    },
    retryDeliveryForChannelFailure(...args) {
      this.calls.push(['channel-retry', ...args]);
    },
    failDelivery(...args) {
      this.calls.push(['fail', ...args]);
    },
    failDeliveryForChannelFailure(...args) {
      this.calls.push(['channel-fail', ...args]);
    },
    failDeliveryAndDisableEndpoint(...args) {
      this.calls.push(['fail-disable', ...args]);
    },
  };
}
