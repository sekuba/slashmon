import assert from 'node:assert/strict';
import test from 'node:test';

import { SentinelCollector } from '../src/sentinel-collector.mjs';
import { SEQUENCER_A, SEQUENCER_B, silentLogger } from './helpers.mjs';
import { REGISTRY, ROLLUP, createRepository, protocolSnapshot } from './case-fixtures.mjs';

test('sentinel reports an unavailable canonical L1 dependency', async () => {
  const repository = createRepository();
  const collector = new SentinelCollector({
    client: {},
    committeeScanner: {},
    repository,
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    pollIntervalMs: 60_000,
    maxBackoffMs: 60_000,
    logger: silentLogger,
    now: () => 1_000,
  });
  const result = await collector.runOnce();
  assert.equal(result.ok, false);
  assert.match(result.error, /Canonical L1 Rollup is unavailable/);
  repository.close();
});

for (const [label, storedRollupAddress] of [
  ['when the canonical Rollup is replaced', '0x9999999999999999999999999999999999999999'],
  // The switch landed after a node-verified poll and before the node upgraded.
  ['when its state is ahead of the canonical clock', ROLLUP],
]) test(`sentinel restarts its epoch index ${label}`, async () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const inactivity = { targetPercentage: 0.7, consecutiveEpochThreshold: 2 };
  // The replaced Rollup had reached epochs and slots the new one restarts below.
  repository.recordValidatorEpoch(epoch(400), inactivity, {
    epochDuration: 10,
    network: 'mainnet',
    observedAt: 2_000,
    coverageGeneration: 0,
  });
  repository.recordSourceSuccess('aztec_sentinel', {
    version: 2,
    rollupAddress: storedRollupAddress,
    nodeSyncedSlot: '4010',
    lastSyncProgressAt: 2_000,
    bootstrapComplete: true,
    targetPercentage: 0.7,
    consecutiveEpochThreshold: 2,
  }, 2_000);

  const collector = new SentinelCollector({
    client: {
      async getSentinelSyncStatus() {
        return { ready: true, l2Slot: '280' };
      },
      async getNodeInfo() {
        return { l1ChainId: 1, registryAddress: REGISTRY, rollupAddress: ROLLUP };
      },
      async getInactivityConfig() {
        return inactivity;
      },
      async getValidatorStats(sequencer, fromSlot) {
        return epoch(Number(fromSlot) / 10).validators[0];
      },
    },
    committeeScanner: {
      async getEpochCommittee({ epoch: value }) {
        const snapshot = epoch(Number(value));
        return {
          committee: snapshot.committee,
          blockNumber: snapshot.l1BlockNumber,
          blockHash: snapshot.l1BlockHash,
        };
      },
    },
    repository,
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    pollIntervalMs: 60_000,
    maxBackoffMs: 60_000,
    logger: silentLogger,
    now: () => 3_000,
  });
  const result = await collector.runOnce();

  assert.equal(result.ok, true, result.error);
  assert.ok(result.epochsIndexed > 0);
  assert.equal(result.rollupAddress, ROLLUP);
  assert.ok(repository.getValidatorIndexCursor().epoch < 400);
  assert.ok(
    repository.getSequencerRecord(SEQUENCER_A, 'mainnet').cases.some((item) => item.targetEpoch === '400'),
    'the replaced Rollup keeps its case history',
  );
  repository.close();
});

test('consecutive inactive epochs remain distinct cases with an exact streak', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const inactivity = {
    targetPercentage: 0.7,
    consecutiveEpochThreshold: 2,
  };
  repository.recordValidatorEpoch(epoch(26), inactivity, {
    epochDuration: 10,
    network: 'mainnet',
    observedAt: 2_000,
    coverageGeneration: 0,
  });
  repository.recordValidatorEpoch(epoch(27), inactivity, {
    epochDuration: 10,
    network: 'mainnet',
    observedAt: 3_000,
    coverageGeneration: 0,
  });

  const cases = repository.getSequencerRecord(SEQUENCER_A, 'mainnet').cases;
  assert.deepEqual(cases.map((item) => item.targetEpoch).sort(), ['26', '27']);
  assert.equal(
    cases.find((item) => item.targetEpoch === '26').state.headline,
    '1 of 2 qualifying inactive epochs',
  );
  assert.equal(
    cases.find((item) => item.targetEpoch === '27').state.headline,
    '2 of 2 qualifying inactive epochs',
  );
  const miss = cases.find((item) => item.targetEpoch === '26').observations
    .find((item) => item.kind === 'duty_miss');
  assert.deepEqual(
    [miss.data.status, miss.data.missed, miss.data.total],
    ['attestation-missed', 8, 10],
    'a duty miss records how many duties were missed of how many',
  );
  repository.close();
});

test('sentinel rejects node aggregates that disagree with exact duty history', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const snapshot = epoch(24);
  snapshot.validators[0].allTimeEpochPerformance[0].missed = '0';
  assert.throws(() => repository.recordValidatorEpoch(snapshot, {
    targetPercentage: 0.7,
    consecutiveEpochThreshold: 2,
  }, {
    epochDuration: 10,
    network: 'mainnet',
    observedAt: 2_000,
  }), /history disagrees/);
  repository.close();
});

test('sentinel indexes the epoch a restarted node never evaluated and streaks across it', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const inactivity = { targetPercentage: 0.7, consecutiveEpochThreshold: 2 };
  const options = { epochDuration: 10, network: 'mainnet', coverageGeneration: 0 };
  repository.recordValidatorEpoch(epoch(26), inactivity, { ...options, observedAt: 2_000 });
  // The node restarted at slot 273, inside epoch 27, and never closed it.
  const restarted = epoch(27);
  restarted.validators[0].allTimeEpochPerformance = [];
  restarted.validators[0].initialSlot = '273';
  const result = repository.recordValidatorEpoch(restarted, inactivity, {
    ...options,
    observedAt: 3_000,
  });
  assert.equal(result.unevaluated, true);
  assert.equal(result.epochsFinalized, 0);
  assert.equal(repository.getValidatorIndexCursor().epoch, 27);

  const next = epoch(28);
  next.validators[0].initialSlot = '273';
  repository.recordValidatorEpoch(next, inactivity, { ...options, observedAt: 4_000 });
  const cases = repository.getSequencerRecord(SEQUENCER_A, 'mainnet').cases;
  assert.deepEqual(cases.map((item) => item.targetEpoch).sort(), ['26', '28']);
  assert.equal(
    cases.find((item) => item.targetEpoch === '28').state.headline,
    '2 of 2 qualifying inactive epochs',
  );
  repository.close();
});

test('sentinel still rejects a missing aggregate for an epoch the node should have closed', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const inactivity = { targetPercentage: 0.7, consecutiveEpochThreshold: 2 };
  const options = { epochDuration: 10, network: 'mainnet', observedAt: 2_000 };
  const missing = epoch(27);
  missing.validators[0].allTimeEpochPerformance = [];
  missing.validators[0].initialSlot = '265';
  assert.throws(
    () => repository.recordValidatorEpoch(missing, inactivity, options),
    /history disagrees/,
  );

  const partial = epoch(27);
  partial.committee.push(SEQUENCER_B);
  partial.validators.push({
    ...partial.validators[0],
    sequencer: SEQUENCER_B,
    allTimeEpochPerformance: [],
    initialSlot: '273',
  });
  assert.throws(
    () => repository.recordValidatorEpoch(partial, inactivity, options),
    /only part of its committee/,
  );
  repository.close();
});

function epoch(value) {
  const fromSlot = value * 10;
  const history = Array.from({ length: 10 }, (_, offset) => ({
    slot: String(fromSlot + offset),
    status: offset < 8 ? 'attestation-missed' : 'attestation-sent',
  }));
  return {
    epoch: String(value),
    fromSlot: String(fromSlot),
    toSlot: String(fromSlot + 9),
    committee: [SEQUENCER_A],
    l1BlockNumber: '100',
    l1BlockHash: `0x${'ab'.repeat(32)}`,
    validators: [{
      sequencer: SEQUENCER_A,
      history,
      allTimeEpochPerformance: [{
        epoch: String(value),
        missed: '8',
        total: '10',
      }],
      lastProcessedSlot: String(fromSlot + 9),
    }],
  };
}
