import assert from 'node:assert/strict';
import test from 'node:test';

import { L1Collector } from '../src/l1-collector.mjs';
import { SEQUENCER_A, silentLogger } from './helpers.mjs';
import {
  PROPOSER,
  REGISTRY,
  createRepository,
  hash,
  protocolSnapshot,
  targetRound,
} from './case-fixtures.mjs';

test('confirmed Slashed logs attach only to an exact execution case', async () => {
  const repository = createRepository();
  let logCalls = 0;
  const scanner = {
    async scan() {
      return protocolSnapshot({
        rounds: [targetRound({ sequencer: SEQUENCER_A, targetEpoch: '24' })],
      });
    },
    async scanSlashLogChunk(previous) {
      logCalls += 1;
      if (!previous.lastBlockNumber) {
        return slashChunk({
          from: 1,
          to: 2,
          confirmed: 4,
          hasMore: true,
          logs: [slashLog(1)],
          initial: true,
          initialBackfill: true,
          backfillStartBlock: 1,
        });
      }
      assert.equal(previous.lastBlockNumber, '2');
      return slashChunk({
        from: 3,
        to: 4,
        confirmed: 4,
        hasMore: false,
        logs: [],
        initialBackfill: true,
        backfillStartBlock: 1,
      });
    },
  };
  const collector = new L1Collector({
    scanner,
    repository,
    network: 'mainnet',
    pollIntervalMs: 1_000,
    maxBackoffMs: 10_000,
    maxSlashLogChunksPerPoll: 5,
    maxSlashLogRunMs: 5_000,
    logger: silentLogger,
    now: () => 1_700_000_200_000,
  });

  const result = await collector.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.slashLogs.inserted, 1);
  assert.equal(logCalls, 2);
  const source = repository.getSourceState('l1_slash_logs');
  assert.equal(source.lastBlockNumber, '4');
  assert.equal(source.metadata.initialBackfill, false);
  assert.equal(source.metadata.backfillStartBlock, '1');
  const [item] = repository.getSequencerRecord(SEQUENCER_A, 'mainnet').cases;
  assert.equal(item.targetEpoch, '24');
  assert.equal(item.state.stage, 'stake_removed');
  assert.equal(item.state.actualAmount, '42');
  repository.close();
});

test('recorded slashes gain block times in bounded batches that never block collection', async () => {
  const repository = createRepository();
  const requested = [];
  let failFacts = true;
  const scanner = {
    async scan() {
      return protocolSnapshot({
        rounds: [targetRound({ sequencer: SEQUENCER_A, targetEpoch: '24' })],
      });
    },
    async scanSlashLogChunk() {
      return slashChunk({ from: 1, to: 2, confirmed: 2, hasMore: false, logs: [slashLog(1)] });
    },
    async readSlashFacts(slashes) {
      requested.push(slashes.map((slash) => slash.blockNumber));
      if (failFacts) throw new Error('archive node unavailable');
      return slashes.map((slash) => ({
        id: slash.id,
        blockTimestamp: '1700000100',
        stakeAfter: '199958',
        ejectionThreshold: '190000',
      }));
    },
  };
  const collector = new L1Collector({
    scanner,
    repository,
    network: 'mainnet',
    pollIntervalMs: 1_000,
    maxBackoffMs: 10_000,
    maxSlashFactsPerPoll: 5,
    logger: silentLogger,
    now: () => 1_700_000_200_000,
  });

  const failed = await collector.runOnce();
  assert.equal(failed.ok, true, 'a failed backfill leaves the live snapshot successful');
  assert.equal(failed.slashLogs.inserted, 1);
  assert.equal(failed.slashFacts.ok, false);

  failFacts = false;
  assert.deepEqual((await collector.runOnce()).slashFacts, { ok: true, cases: 1, casesChanged: 1 });
  assert.deepEqual((await collector.runOnce()).slashFacts, { ok: true, cases: 0 });
  assert.deepEqual(requested, [['1'], ['1']], 'an enriched slash is not read again');
  const [item] = repository.getSequencerRecord(SEQUENCER_A, 'mainnet').cases;
  const slash = item.observations.find((observation) => observation.kind === 'l1_slash');
  assert.equal(slash.provenance.blockTime, new Date(1_700_000_100_000).toISOString());
  assert.equal(slash.data.stakeAfter, '199958');
  repository.close();
});

test('log backfill yields so every poll starts with a fresh L1 snapshot', async () => {
  const repository = createRepository();
  let snapshots = 0;
  const scanner = {
    async scan() {
      snapshots += 1;
      return protocolSnapshot({ block: 200 + snapshots });
    },
    async scanSlashLogChunk(_previous, signal) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
  const collector = new L1Collector({
    scanner,
    repository,
    network: 'mainnet',
    pollIntervalMs: 1_000,
    maxBackoffMs: 10_000,
    maxSlashLogChunksPerPoll: 25,
    maxSlashLogRunMs: 20,
    logger: silentLogger,
    now: () => 1_700_000_200_000,
  });

  assert.equal((await collector.runOnce()).slashLogs.yielded, true);
  assert.equal((await collector.runOnce()).slashLogs.yielded, true);
  assert.equal(snapshots, 2);
  repository.close();
});

function slashChunk({
  from,
  to,
  confirmed,
  logs,
  hasMore,
  initial = false,
  initialBackfill = false,
  backfillStartBlock = null,
}) {
  return {
    chainId: 1,
    fromBlock: String(from),
    toBlock: String(to),
    toBlockHash: hash(to),
    confirmedBlockNumber: String(confirmed),
    registryAddress: REGISTRY,
    rollupAddresses: ['0x2222222222222222222222222222222222222222'],
    logs,
    hasMore,
    initial,
    initialBackfill,
    backfillStartBlock: backfillStartBlock === null
      ? null
      : String(backfillStartBlock),
    reorgDetected: false,
  };
}

function slashLog(block) {
  return {
    rollupAddress: '0x2222222222222222222222222222222222222222',
    blockNumber: String(block),
    blockHash: hash(block),
    transactionHash: hash(block + 1_000),
    logIndex: 0,
    sequencer: SEQUENCER_A,
    amount: '42',
    executionCandidates: [{ proposerAddress: PROPOSER, round: '14' }],
    transactionSlashIndex: 0,
    ejected: false,
  };
}

