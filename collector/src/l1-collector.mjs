import { errorMessage } from './logger.mjs';
import { PollingWorker } from './polling-worker.mjs';

export class L1Collector extends PollingWorker {
  constructor({
    scanner,
    repository,
    network,
    pollIntervalMs,
    maxBackoffMs,
    maxSlashLogChunksPerPoll = 25,
    maxSlashLogRunMs = 60_000,
    maxSlashFactsPerPoll = 25,
    logger,
    now = Date.now,
  }) {
    super();
    this.scanner = scanner;
    this.repository = repository;
    this.network = network;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs;
    this.maxSlashLogChunksPerPoll = maxSlashLogChunksPerPoll;
    this.maxSlashLogRunMs = maxSlashLogRunMs;
    this.maxSlashFactsPerPoll = maxSlashFactsPerPoll;
    this.logger = logger;
    this.now = now;
  }

  async runOnce() {
    const snapshot = await this.runSnapshotOnce();
    if (snapshot.stopped) return { ...snapshot, slashLogs: { ok: false, stopped: true } };
    const slashLogs = await this.runSlashLogsOnce();
    const slashFacts = await this.runSlashFactsOnce();
    return { ...snapshot, slashLogs, slashFacts };
  }

  // Slashes recorded before block times and post-slash stake were collected
  // gain them a bounded batch per poll. A failure retries on the next poll
  // and never blocks live collection.
  async runSlashFactsOnce() {
    if (typeof this.scanner.readSlashFacts !== 'function') {
      return { ok: false, disabled: true };
    }
    const pending = this.repository.listSlashesWithoutBlockTime(this.maxSlashFactsPerPoll);
    if (pending.length === 0) return { ok: true, cases: 0 };
    const controller = this.trackRequest();
    try {
      const facts = await this.scanner.readSlashFacts(pending, controller.signal);
      const result = this.repository.addSlashFacts(facts);
      this.logger.info('Added block times to recorded slashes', {
        requested: pending.length,
        cases: result.cases,
      });
      return { ok: true, ...result };
    } catch (error) {
      if (!this.running && controller.signal.aborted) return { ok: false, stopped: true };
      const message = errorMessage(error);
      this.logger.warn('Slash block time backfill failed; retrying next poll', { error: message });
      return { ok: false, error: message };
    } finally {
      this.releaseRequest(controller);
    }
  }

  async runSnapshotOnce() {
    const attemptedAt = this.now();
    this.repository.recordSourceAttempt('l1', attemptedAt);
    const controller = this.trackRequest();
    let snapshot;
    try {
      const previous = this.repository.getSourceState('l1') ?? {};
      snapshot = await this.scanner.scan(previous, controller.signal);
    } catch (error) {
      if (!this.running && controller.signal.aborted) return { ok: false, stopped: true };
      const message = errorMessage(error);
      this.repository.recordSourceFailure('l1', message, this.now());
      const state = this.repository.getSourceState('l1');
      this.logger.warn('L1 scan failed; retained the last complete snapshot', {
        consecutiveFailures: state.consecutiveFailures,
        error: message,
      });
      return { ok: false, error: message, consecutiveFailures: state.consecutiveFailures };
    } finally {
      this.releaseRequest(controller);
    }

    const previousFailures = this.repository.getSourceState('l1')?.consecutiveFailures ?? 0;
    const result = this.repository.recordSuccessfulL1Snapshot(this.network, snapshot, {
      observedAt: this.now(),
    });
    if (previousFailures > 0) {
      this.logger.info('L1 connection recovered', { previousFailures });
    }
    this.logger.debug('L1 snapshot completed', {
      blockNumber: snapshot.blockNumber,
      stacks: snapshot.stacks.length,
      changed: result.changed ?? 0,
      reorgDetected: snapshot.reorgDetected,
    });
    if (result.changed || snapshot.reorgDetected) {
      this.logger.info('Onchain slashing state changed', {
        changed: result.changed,
        transitions: result.transitions,
        reorgDetected: snapshot.reorgDetected,
      });
    }
    return { ok: true, ...result };
  }

  async runSlashLogsOnce() {
    if (typeof this.scanner.scanSlashLogChunk !== 'function') {
      return { ok: false, disabled: true };
    }
    this.repository.recordSourceAttempt('l1_slash_logs', this.now());
    const controller = this.trackRequest();
    const deadlineSignal = AbortSignal.timeout(this.maxSlashLogRunMs);
    const requestSignal = AbortSignal.any([controller.signal, deadlineSignal]);
    const previousFailures = this.repository.getSourceState('l1_slash_logs')?.consecutiveFailures ?? 0;
    const totals = { chunks: 0, inserted: 0, queued: 0, corrections: 0 };
    try {
      for (let index = 0; index < this.maxSlashLogChunksPerPoll; index += 1) {
        const previous = this.repository.getSourceState('l1_slash_logs') ?? {};
        const chunk = await this.scanner.scanSlashLogChunk(previous, requestSignal);
        const result = this.repository.recordSuccessfulL1SlashLogChunk(this.network, chunk, {
          observedAt: this.now(),
        });
        totals.chunks += 1;
        totals.inserted += result.inserted;
        totals.queued += result.queued;
        totals.corrections += result.corrections;
        totals.fromBlock ??= result.fromBlock;
        totals.toBlock = result.toBlock;
        totals.hasMore = result.hasMore;
        totals.reorgDetected ||= result.reorgDetected;
        if (!result.hasMore) break;
      }
    } catch (error) {
      if (!this.running && controller.signal.aborted) return { ok: false, stopped: true, ...totals };
      if (deadlineSignal.aborted) {
        this.logger.debug('Yielded confirmed Slashed log backfill to the next fresh snapshot', totals);
        return { ok: true, yielded: true, ...totals };
      }
      const message = errorMessage(error);
      this.repository.recordSourceFailure('l1_slash_logs', message, this.now());
      const state = this.repository.getSourceState('l1_slash_logs');
      this.logger.warn('Confirmed Slashed log backfill failed; retained its durable checkpoint', {
        consecutiveFailures: state.consecutiveFailures,
        checkpoint: state.lastBlockNumber,
        error: message,
      });
      return { ok: false, error: message, consecutiveFailures: state.consecutiveFailures, ...totals };
    } finally {
      this.releaseRequest(controller);
    }

    if (previousFailures > 0) {
      this.logger.info('Confirmed Slashed log backfill recovered', { previousFailures });
    }
    if (totals.inserted || totals.corrections || totals.reorgDetected) {
      this.logger.info('Confirmed Slashed log journal advanced', totals);
    } else {
      this.logger.debug('Confirmed Slashed log checkpoint advanced', totals);
    }
    return { ok: true, yielded: Boolean(totals.hasMore), ...totals };
  }
}
