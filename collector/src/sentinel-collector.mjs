import { readCanonicalRollupAddress, validateNodeIdentity } from './collector.mjs';
import { errorMessage } from './logger.mjs';
import { PollingWorker } from './polling-worker.mjs';

const SENTINEL_SLOT_PROCESSING_LAG = 2;

export class SentinelCollector extends PollingWorker {
  constructor({
    client,
    committeeScanner,
    repository,
    network = 'mainnet',
    expectedChainId,
    expectedRegistryAddress,
    pollIntervalMs,
    maxBackoffMs,
    lookbackEpochs = 3,
    epochEndBufferSlots = 2,
    validatorConcurrency = 8,
    maxStallMs = 5 * 60_000,
    logger,
    now = Date.now,
  }) {
    super();
    this.client = client;
    this.committeeScanner = committeeScanner;
    this.repository = repository;
    this.network = network;
    this.expectedChainId = expectedChainId;
    this.expectedRegistryAddress = expectedRegistryAddress;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.lookbackEpochs = requirePositiveSafeInteger(lookbackEpochs, 'sentinel lookback epochs');
    this.epochEndBufferSlots = requireUnsignedSafeInteger(
      epochEndBufferSlots,
      'sentinel epoch-end buffer',
    );
    this.validatorConcurrency = requirePositiveSafeInteger(
      validatorConcurrency,
      'sentinel validator concurrency',
    );
    this.maxStallMs = maxStallMs;
    this.logger = logger;
    this.now = now;
  }

  async runOnce() {
    const attemptedAt = this.now();
    this.repository.recordSourceAttempt('aztec_sentinel', attemptedAt);
    const l1State = this.repository.getSourceState('l1');
    const l1Metadata = l1State?.metadata;
    const canonicalRollupAddress = readCanonicalRollupAddress(this.repository);
    if (!canonicalRollupAddress) {
      return this.recordPollFailure(
        'Canonical L1 Rollup is unavailable; validator duties are not trusted yet',
        attemptedAt,
      );
    }
    let l1Checkpoint;
    let epochDuration;
    let confirmedL1Slot;
    try {
      epochDuration = requirePositiveSafeInteger(
        l1Metadata?.epochDuration,
        'canonical L1 epoch duration',
      );
      confirmedL1Slot = requireUnsignedSafeInteger(
        l1Metadata?.currentSlot,
        'canonical L1 current slot',
      );
      l1Checkpoint = {
        rollupAddress: canonicalRollupAddress,
        blockNumber: requireUnsignedIntegerString(
          l1State?.lastBlockNumber,
          'canonical L1 block number',
        ),
        blockHash: requireBlockHash(l1State?.lastBlockHash),
      };
    } catch (error) {
      return this.recordPollFailure(errorMessage(error), attemptedAt);
    }

    const controller = this.trackRequest();
    try {
      const priorState = this.repository.getSourceState('aztec_sentinel');
      let prior = priorState?.metadata ?? {};
      // Only a node-verified poll records the index's Rollup, but the switch can
      // land after one and before the node upgrades. State ahead of the
      // canonical clock belongs to the replaced Rollup either way.
      const priorCursor = this.repository.getValidatorIndexCursor();
      const aheadOfCanonicalClock =
        Number(prior.nodeSyncedSlot ?? 0) > confirmedL1Slot + epochDuration ||
        (priorCursor !== undefined && priorCursor.epoch * epochDuration > confirmedL1Slot + epochDuration);
      if (
        (prior.rollupAddress !== undefined && prior.rollupAddress !== canonicalRollupAddress) ||
        aheadOfCanonicalClock
      ) {
        const reset = this.repository.resetSentinelIndex();
        this.logger.warn('Canonical Rollup changed; reset the Aztec sentinel epoch index', {
          previousRollupAddress: prior.rollupAddress ?? null,
          previousSyncedSlot: prior.nodeSyncedSlot ?? null,
          rollupAddress: canonicalRollupAddress,
          ...reset,
        });
        prior = {};
      }
      const syncStatus = await this.client.getSentinelSyncStatus(controller.signal);
      validateSentinelProgress(syncStatus, {
        prior,
        observedAt: this.now(),
        maxStallMs: this.maxStallMs,
      });
      const syncedL2Slot = requireUnsignedSafeInteger(syncStatus.l2Slot, 'synced L2 slot');
      let config = readStoredConfig(prior);
      const cursor = this.repository.getValidatorIndexCursor();

      // On steady-state minute polls this is the only Aztec-node sync check. The
      // heavier identity/config/committee-member calls run only when a newly
      // completed epoch can actually advance the durable cursor.
      if (config) {
        const ready = latestReadyEpoch({
          syncedL2Slot,
          confirmedL1Slot,
          epochDuration,
          epochEndBufferSlots: this.epochEndBufferSlots,
        });
        if (cursor && ready <= cursor.epoch) {
          return this.recordSuccess({
            prior,
            rollupAddress: prior.rollupAddress,
            cursor,
            config,
            syncStatus,
            syncedL2Slot,
            ready,
            l1Checkpoint,
            epochDuration,
            indexed: [],
            coverageReset: false,
            observedAt: this.now(),
          }, priorState?.consecutiveFailures ?? 0);
        }
      }

      const [nodeInfo, freshConfig] = await Promise.all([
        this.client.getNodeInfo(controller.signal),
        this.client.getInactivityConfig(controller.signal),
      ]);
      validateNodeIdentity(nodeInfo, {
        expectedChainId: this.expectedChainId,
        expectedRegistryAddress: this.expectedRegistryAddress,
        canonicalRollupAddress,
      });
      config = freshConfig;
      const ready = latestReadyEpoch({
        syncedL2Slot,
        confirmedL1Slot,
        epochDuration,
        epochEndBufferSlots: this.epochEndBufferSlots,
      });
      if (ready < 0 || (cursor && ready <= cursor.epoch)) {
        return this.recordSuccess({
          prior,
          rollupAddress: canonicalRollupAddress,
          cursor,
          config,
          syncStatus,
          syncedL2Slot,
          ready,
          l1Checkpoint,
          epochDuration,
          indexed: [],
          coverageReset: false,
          observedAt: this.now(),
        }, priorState?.consecutiveFailures ?? 0);
      }

      const earliestLookbackEpoch = Math.max(0, ready - this.lookbackEpochs + 1);
      let startEpoch = cursor ? cursor.epoch + 1 : earliestLookbackEpoch;
      const coverageReset = Boolean(cursor && startEpoch < earliestLookbackEpoch);
      if (coverageReset) startEpoch = earliestLookbackEpoch;
      const coverageGeneration = coverageReset
        ? cursor.coverageGeneration + 1
        : cursor?.coverageGeneration ?? 0;
      const bootstrap = prior.bootstrapComplete !== true ||
        coverageReset ||
        cursor?.coverageGeneration > Number(prior.coverageGeneration ?? 0);
      const indexed = [];
      for (let epoch = startEpoch; epoch <= ready; epoch += 1) {
        const fromSlot = checkedSlotProduct(epoch, epochDuration);
        const toSlot = checkedSlotEnd(fromSlot, epochDuration);
        const committeeSnapshot = await this.committeeScanner.getEpochCommittee({
          ...l1Checkpoint,
          epoch: String(epoch),
        }, controller.signal);
        const responses = await mapWithConcurrency(
          committeeSnapshot.committee,
          this.validatorConcurrency,
          async (sequencer) => await this.client.getValidatorStats(
            sequencer,
            String(fromSlot),
            String(toSlot),
            controller.signal,
          ),
        );
        const validators = responses.filter(Boolean);
        const result = this.repository.recordValidatorEpoch({
          epoch: String(epoch),
          fromSlot: String(fromSlot),
          toSlot: String(toSlot),
          committee: committeeSnapshot.committee,
          validators,
          l1BlockNumber: committeeSnapshot.blockNumber,
          l1BlockHash: committeeSnapshot.blockHash,
        }, config, {
          epochDuration,
          network: this.network,
          observedAt: this.now(),
          bootstrap,
          coverageGeneration,
        });
        indexed.push(result);
      }
      return this.recordSuccess({
        prior,
        rollupAddress: canonicalRollupAddress,
        cursor: this.repository.getValidatorIndexCursor(),
        config,
        syncStatus,
        syncedL2Slot,
        ready,
        l1Checkpoint,
        epochDuration,
        indexed,
        coverageReset,
        observedAt: this.now(),
      }, priorState?.consecutiveFailures ?? 0);
    } catch (error) {
      if (!this.running && controller.signal.aborted) return { ok: false, stopped: true };
      controller.abort();
      return this.recordPollFailure(errorMessage(error), this.now());
    } finally {
      this.releaseRequest(controller);
    }
  }

  recordSuccess(input, previousFailures) {
    const previousNodeSlot = input.prior.nodeSyncedSlot === undefined
      ? undefined
      : requireUnsignedSafeInteger(input.prior.nodeSyncedSlot, 'stored node sync cursor');
    const metadata = {
      version: 2,
      lastIndexedEpoch: input.cursor ? String(input.cursor.epoch) : null,
      firstIndexedEpoch: input.prior.firstIndexedEpoch ??
        (input.indexed[0]?.epoch ?? null),
      latestReadyEpoch: input.ready < 0 ? null : String(input.ready),
      lookbackEpochs: this.lookbackEpochs,
      coverageGeneration: input.cursor?.coverageGeneration ?? 0,
      coverageResets: Number(input.prior.coverageResets ?? 0) + Number(input.coverageReset),
      bootstrapComplete: input.prior.bootstrapComplete === true || input.indexed.length > 0,
      nodeSyncedSlot: String(input.syncedL2Slot),
      lastSyncProgressAt: previousNodeSlot === undefined || input.syncedL2Slot > previousNodeSlot
        ? input.observedAt
        : input.prior.lastSyncProgressAt,
      nodeReady: Boolean(input.syncStatus.ready),
      epochEndBufferSlots: this.epochEndBufferSlots,
      targetPercentage: input.config.targetPercentage,
      consecutiveEpochThreshold: input.config.consecutiveEpochThreshold,
      epochDuration: String(input.epochDuration),
      l1BlockNumber: input.l1Checkpoint.blockNumber,
      l1BlockHash: input.l1Checkpoint.blockHash,
      rollupAddress: input.rollupAddress,
      lastEpochIndexedAt: input.indexed.length > 0
        ? input.observedAt
        : input.prior.lastEpochIndexedAt ?? null,
    };
    this.repository.recordSourceSuccess('aztec_sentinel', metadata, input.observedAt);
    if (previousFailures > 0) {
      this.logger.info('Aztec sentinel source recovered', { previousFailures });
    }
    const totals = input.indexed.reduce((accumulator, result) => ({
      dutiesInserted: accumulator.dutiesInserted + result.dutiesInserted,
      committeeRows: accumulator.committeeRows + result.epochsFinalized,
      inactiveEpochs: accumulator.inactiveEpochs + result.inactiveEpochs,
      transitions: accumulator.transitions + result.transitions,
    }), { dutiesInserted: 0, committeeRows: 0, inactiveEpochs: 0, transitions: 0 });
    const result = {
      ok: true,
      epochsIndexed: input.indexed.length,
      coverageReset: input.coverageReset,
      ...totals,
      ...metadata,
    };
    if (input.indexed.length > 0) {
      this.logger.info('Aztec sentinel epoch index advanced', result);
    } else {
      this.logger.debug('Aztec sentinel sync poll completed without a new epoch', result);
    }
    return result;
  }

  recordPollFailure(message, at) {
    return this.pollFailure(
      'aztec_sentinel',
      'Aztec sentinel poll failed; retained the durable epoch index',
      message,
      at,
    );
  }
}

export function validateSentinelProgress(syncStatus, {
  prior,
  observedAt,
  maxStallMs,
}) {
  if (!syncStatus?.ready) throw new Error('Aztec node is not ready; validator duties are not trusted');
  if (syncStatus.l2Slot === undefined) {
    throw new Error('Aztec node returned no synced L2 slot for validator duties');
  }
  const syncedSlot = requireUnsignedSafeInteger(syncStatus.l2Slot, 'synced L2 slot');
  if (prior?.nodeSyncedSlot !== undefined) {
    const previousSlot = requireUnsignedSafeInteger(prior.nodeSyncedSlot, 'stored node sync cursor');
    if (syncedSlot < previousSlot) {
      throw new Error(`Aztec node sync cursor regressed from ${previousSlot} to ${syncedSlot}`);
    }
    if (
      syncedSlot === previousSlot &&
      Number.isSafeInteger(prior.lastSyncProgressAt) &&
      observedAt - prior.lastSyncProgressAt > maxStallMs
    ) {
      throw new Error('Aztec node sync cursor has stalled');
    }
  }
}

export function latestReadyEpoch({
  syncedL2Slot,
  confirmedL1Slot,
  epochDuration,
  epochEndBufferSlots,
}) {
  const synced = requireUnsignedSafeInteger(syncedL2Slot, 'synced L2 slot');
  const confirmed = requireUnsignedSafeInteger(confirmedL1Slot, 'confirmed L1 slot');
  const duration = requirePositiveSafeInteger(epochDuration, 'epoch duration');
  const buffer = requireUnsignedSafeInteger(epochEndBufferSlots, 'sentinel epoch-end buffer');
  const effectiveSlot = Math.min(synced, confirmed);
  const lag = Math.max(SENTINEL_SLOT_PROCESSING_LAG, buffer);
  return Math.floor((effectiveSlot + 1 - lag) / duration) - 1;
}

async function mapWithConcurrency(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(values.length, concurrency) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function readStoredConfig(metadata) {
  if (
    metadata.targetPercentage === undefined ||
    metadata.consecutiveEpochThreshold === undefined
  ) {
    return undefined;
  }
  const targetPercentage = Number(metadata.targetPercentage);
  if (!Number.isFinite(targetPercentage) || targetPercentage < 0 || targetPercentage > 1) {
    return undefined;
  }
  return {
    targetPercentage,
    consecutiveEpochThreshold: requirePositiveSafeInteger(
      metadata.consecutiveEpochThreshold,
      'stored inactivity threshold',
    ),
  };
}

function checkedSlotProduct(epoch, duration) {
  const value = epoch * duration;
  if (!Number.isSafeInteger(value)) throw new Error('validator epoch slot range exceeds the safe integer range');
  return value;
}

function checkedSlotEnd(fromSlot, duration) {
  const value = fromSlot + duration - 1;
  if (!Number.isSafeInteger(value)) throw new Error('validator epoch slot range exceeds the safe integer range');
  return value;
}

function requirePositiveSafeInteger(value, label) {
  const parsed = requireUnsignedSafeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function requireUnsignedSafeInteger(value, label) {
  const normalized = requireUnsignedIntegerString(value, label);
  const parsed = BigInt(normalized);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range`);
  return Number(parsed);
}

function requireUnsignedIntegerString(value, label) {
  if (
    !(
      (typeof value === 'string' && /^[0-9]+$/.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    )
  ) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(value).toString();
}

function requireBlockHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('canonical L1 block hash must be a 32-byte hex value');
  }
  return value.toLowerCase();
}
