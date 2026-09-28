import assert from 'node:assert/strict';
import test from 'node:test';

import { SentinelCollector } from '../src/sentinel-collector.mjs';
import { SEQUENCER_A, silentLogger } from './helpers.mjs';
import { REGISTRY, createRepository, protocolSnapshot } from './case-fixtures.mjs';

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
