import { errorMessage } from './logger.mjs';
import { PollingWorker } from './polling-worker.mjs';

export class OffenseCollector extends PollingWorker {
  constructor({
    client,
    repository,
    network = 'mainnet',
    expectedChainId,
    expectedRegistryAddress,
    syncMaxL1AgeMs = 5 * 60_000,
    syncMaxL2StallMs = 5 * 60_000,
    syncMaxFutureSkewMs = 2 * 60_000,
    pollIntervalMs,
    maxBackoffMs,
    withdrawAfterMissedPolls,
    logger,
    now = Date.now,
  }) {
    super();
    this.client = client;
    this.repository = repository;
    this.network = network;
    if (!Number.isSafeInteger(expectedChainId) || expectedChainId < 1) {
      throw new Error('OffenseCollector requires a positive expectedChainId');
    }
    this.expectedChainId = expectedChainId;
    this.expectedRegistryAddress = normalizeAddress(expectedRegistryAddress, 'expected Registry');
    this.syncMaxL1AgeMs = requirePositiveDuration(syncMaxL1AgeMs, 'syncMaxL1AgeMs');
    this.syncMaxL2StallMs = requirePositiveDuration(syncMaxL2StallMs, 'syncMaxL2StallMs');
    this.syncMaxFutureSkewMs = requireNonNegativeDuration(syncMaxFutureSkewMs, 'syncMaxFutureSkewMs');
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.withdrawAfterMissedPolls = withdrawAfterMissedPolls;
    this.logger = logger;
    this.now = now;
  }

  async runOnce() {
    const attemptedAt = this.now();
    this.repository.recordAttempt(attemptedAt);
    // Reads stay outside the request-error boundary: SQLite faults are fatal,
    // while a not-yet-established canonical Rollup is an ordinary degraded source.
    const canonicalRollupAddress = readCanonicalRollupAddress(this.repository);
    let previousSyncCursor = this.repository.getSourceState('aztec_sync')?.metadata;
    if (!canonicalRollupAddress) {
      return this.recordPollFailure(
        'Canonical L1 Rollup is unavailable; pending offenses are not trusted yet',
        attemptedAt,
      );
    }
    // A cursor without a Rollup predates rollup tracking and is treated as
    // belonging to a replaced one.
    if (previousSyncCursor && previousSyncCursor.rollupAddress !== canonicalRollupAddress) {
      const reset = this.repository.resetOffenseTracking();
      this.logger.warn('Canonical Rollup changed; reset Aztec offense tracking', {
        previousRollupAddress: previousSyncCursor.rollupAddress ?? null,
        rollupAddress: canonicalRollupAddress,
        ...reset,
      });
      previousSyncCursor = undefined;
    }

    const controller = this.trackRequest();

    let offenses;
    let nodeSyncStatus;
    let syncReadError;
    try {
      const nodeInfo = await this.client.getNodeInfo(controller.signal);
      validateNodeIdentity(nodeInfo, {
        expectedChainId: this.expectedChainId,
        expectedRegistryAddress: this.expectedRegistryAddress,
        canonicalRollupAddress,
      });
      try {
        nodeSyncStatus = await this.client.getNodeSyncStatus(controller.signal);
      } catch (error) {
        syncReadError = errorMessage(error);
      }
      offenses = await this.client.getAllSlashOffenses(controller.signal);
    } catch (error) {
      if (!this.running && controller.signal.aborted) {
        return { ok: false, stopped: true };
      }
      return this.recordPollFailure(errorMessage(error), this.now());
    } finally {
      this.releaseRequest(controller);
    }

    // Repository failures are process-fatal. Retrying a broken journal while still
    // claiming liveness would be worse than letting the supervisor restart us.
    const previousFailures = this.repository.getSyncState().consecutiveFailures;
    const completedAt = this.now();
    const syncAssessment = assessNodeSync(nodeSyncStatus, {
      previous: previousSyncCursor,
      rollupAddress: canonicalRollupAddress,
      observedAt: completedAt,
      maxL1AgeMs: this.syncMaxL1AgeMs,
      maxL2StallMs: this.syncMaxL2StallMs,
      maxFutureSkewMs: this.syncMaxFutureSkewMs,
      readError: syncReadError,
    });
    const result = this.repository.recordSuccessfulPoll(offenses, {
      observedAt: completedAt,
      withdrawAfterMissedPolls: this.withdrawAfterMissedPolls,
      network: this.network,
      absenceEvidence: syncAssessment.absenceEvidence,
      syncCursor: syncAssessment.nextCursor,
      degradedError: syncAssessment.error,
    });
    if (result.degraded) {
      const state = this.repository.getSyncState();
      this.logger.warn('Offense snapshot contained positive signals but was unsafe as negative evidence', {
        consecutiveFailures: state.consecutiveFailures,
        error: result.error,
        observed: result.observed,
      });
      return { ok: false, ...result, consecutiveFailures: state.consecutiveFailures };
    }
    if (previousFailures > 0) {
      this.logger.info('Aztec offense source recovered', { previousFailures });
    }
    this.logger.debug('Offense poll completed', result);
    if (result.inserted || result.updated || result.reactivated || result.withdrawn) {
      this.logger.info('Offense state changed', result);
    }
    return { ok: true, ...result };
  }

  recordPollFailure(message, at) {
    return this.pollFailure(
      'aztec_node',
      'Offense poll failed; retained the last successful snapshot',
      message,
      at,
    );
  }
}

export function validateNodeIdentity(nodeInfo, {
  expectedChainId,
  expectedRegistryAddress,
  canonicalRollupAddress,
}) {
  if (!nodeInfo || typeof nodeInfo !== 'object' || Array.isArray(nodeInfo)) {
    throw new Error('Aztec node returned an invalid identity');
  }
  if (nodeInfo.l1ChainId !== expectedChainId) {
    throw new Error(`Aztec node L1 chain mismatch: reported ${String(nodeInfo.l1ChainId)}, expected ${expectedChainId}`);
  }
  const registryAddress = normalizeAddress(nodeInfo.registryAddress, 'node Registry');
  const expectedRegistry = normalizeAddress(expectedRegistryAddress, 'expected Registry');
  if (registryAddress !== expectedRegistry) {
    throw new Error(`Aztec node Registry mismatch: reported ${registryAddress}, expected ${expectedRegistry}`);
  }
  const rollupAddress = normalizeAddress(nodeInfo.rollupAddress, 'node Rollup');
  const canonicalRollup = canonicalRollupAddress
    ? normalizeAddress(canonicalRollupAddress, 'canonical L1 Rollup')
    : undefined;
  if (canonicalRollup && rollupAddress !== canonicalRollup) {
    throw new Error(`Aztec node Rollup mismatch: reported ${rollupAddress}, canonical L1 is ${canonicalRollup}`);
  }
}

export function readCanonicalRollupAddress(repository) {
  const value = repository.getSourceState('l1')?.metadata?.rollupAddress;
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeAddress(value, 'canonical L1 Rollup');
}

export function assessNodeSync(status, {
  previous,
  rollupAddress,
  observedAt,
  maxL1AgeMs,
  maxL2StallMs,
  maxFutureSkewMs,
  readError,
}) {
  if (readError) return unsafeSync(`Aztec node sync cursor unavailable: ${readError}`);
  if (!status?.ready) return unsafeSync('Aztec node is not ready; absence is not trusted');
  if (status.l1Timestamp === undefined || status.l2Slot === undefined || status.l2Epoch === undefined) {
    return unsafeSync('Aztec node returned an incomplete sync cursor; absence is not trusted');
  }

  let current;
  let prior;
  try {
    current = {
      l1Timestamp: parseCursorInteger(status.l1Timestamp, 'synced L1 timestamp'),
      l2Slot: parseCursorInteger(status.l2Slot, 'synced L2 slot'),
      l2Epoch: parseCursorInteger(status.l2Epoch, 'synced L2 epoch'),
    };
    prior = previous === undefined ? undefined : parseStoredSyncCursor(previous);
  } catch (error) {
    return unsafeSync(errorMessage(error));
  }

  const now = BigInt(observedAt);
  const l1TimestampMs = current.l1Timestamp * 1_000n;
  if (l1TimestampMs > now + BigInt(maxFutureSkewMs)) {
    return unsafeSync('Aztec node synced L1 timestamp is implausibly in the future');
  }
  if (now - l1TimestampMs > BigInt(maxL1AgeMs)) {
    return unsafeSync('Aztec node synced L1 timestamp is stale');
  }

  if (prior) {
    if (observedAt < prior.lastObservedAt) {
      return unsafeSync('Local clock regressed behind the stored Aztec sync cursor');
    }
    if (
      current.l1Timestamp < prior.l1Timestamp ||
      current.l2Slot < prior.l2Slot ||
      current.l2Epoch < prior.l2Epoch
    ) {
      return unsafeSync('Aztec node sync cursor regressed; absence is not trusted');
    }
  }

  const slotProgressed = !prior || current.l2Slot > prior.l2Slot;
  const epochProgressed = !prior || current.l2Epoch > prior.l2Epoch;
  const lastSlotProgressAt = slotProgressed ? observedAt : prior.lastSlotProgressAt;
  if (observedAt - lastSlotProgressAt > maxL2StallMs) {
    return unsafeSync('Aztec node synced L2 slot has stalled');
  }

  const slotAbsenceAdvanced = !prior || current.l2Slot > prior.lastAbsenceSlot;
  const epochAbsenceAdvanced = !prior || current.l2Epoch > prior.lastAbsenceEpoch;
  const nextCursor = {
    version: 1,
    rollupAddress,
    l1Timestamp: current.l1Timestamp.toString(),
    l2Slot: current.l2Slot.toString(),
    l2Epoch: current.l2Epoch.toString(),
    lastObservedAt: observedAt,
    lastSlotProgressAt,
    lastEpochProgressAt: epochProgressed ? observedAt : prior.lastEpochProgressAt,
    lastAbsenceSlot: slotAbsenceAdvanced ? current.l2Slot.toString() : prior.lastAbsenceSlot.toString(),
    lastAbsenceEpoch: epochAbsenceAdvanced ? current.l2Epoch.toString() : prior.lastAbsenceEpoch.toString(),
  };
  return {
    absenceEvidence: {
      slot: { advanced: slotAbsenceAdvanced, value: current.l2Slot.toString() },
      epoch: { advanced: epochAbsenceAdvanced, value: current.l2Epoch.toString() },
    },
    nextCursor,
  };
}

function unsafeSync(error) {
  return { absenceEvidence: {}, error };
}

function parseStoredSyncCursor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('Stored Aztec sync cursor is missing or corrupt');
  }
  const timestamps = ['lastObservedAt', 'lastSlotProgressAt', 'lastEpochProgressAt'];
  for (const name of timestamps) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) {
      throw new Error('Stored Aztec sync cursor is missing or corrupt');
    }
  }
  return {
    l1Timestamp: parseCursorInteger(value.l1Timestamp, 'stored L1 timestamp'),
    l2Slot: parseCursorInteger(value.l2Slot, 'stored L2 slot'),
    l2Epoch: parseCursorInteger(value.l2Epoch, 'stored L2 epoch'),
    lastAbsenceSlot: parseCursorInteger(value.lastAbsenceSlot, 'stored absence slot'),
    lastAbsenceEpoch: parseCursorInteger(value.lastAbsenceEpoch, 'stored absence epoch'),
    lastObservedAt: value.lastObservedAt,
    lastSlotProgressAt: value.lastSlotProgressAt,
    lastEpochProgressAt: value.lastEpochProgressAt,
  };
}

function parseCursorInteger(value, label) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  return BigInt(value);
}

function normalizeAddress(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${label} must be a nonzero 20-byte hex address`);
  }
  return value.toLowerCase();
}

function requirePositiveDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function requireNonNegativeDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
