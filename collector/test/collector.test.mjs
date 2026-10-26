import assert from 'node:assert/strict';
import test from 'node:test';

import { OffenseCollector, validateNodeIdentity } from '../src/collector.mjs';
import { parseOffenseSnapshot } from '../src/offenses.mjs';
import { OFFENSE_A, silentLogger } from './helpers.mjs';
import { REGISTRY, ROLLUP, createRepository, protocolSnapshot } from './case-fixtures.mjs';

test('node identity comparison is case-insensitive but rejects a different Rollup', () => {
  assert.doesNotThrow(() => validateNodeIdentity({
    l1ChainId: 1,
    registryAddress: REGISTRY.toUpperCase().replace('0X', '0x'),
    rollupAddress: ROLLUP.toUpperCase().replace('0X', '0x'),
  }, {
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    canonicalRollupAddress: ROLLUP,
  }));
  assert.throws(() => validateNodeIdentity({
    l1ChainId: 1,
    registryAddress: REGISTRY,
    rollupAddress: '0x9999999999999999999999999999999999999999',
  }, {
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    canonicalRollupAddress: ROLLUP,
  }), /Rollup mismatch/);
});

test('collector does not trust node offenses before canonical L1 discovery', async () => {
  const repository = createRepository();
  let calls = 0;
  const collector = new OffenseCollector({
    client: {
      async getAllSlashOffenses() {
        calls += 1;
        return [OFFENSE_A];
      },
    },
    repository,
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    pollIntervalMs: 1_000,
    maxBackoffMs: 2_000,
    withdrawAfterMissedPolls: 2,
    logger: silentLogger,
    now: () => 1_000,
  });

  const result = await collector.runOnce();
  assert.equal(result.ok, false);
  assert.match(result.error, /Canonical L1 Rollup is unavailable/);
  assert.equal(calls, 0);
  assert.equal(repository.listCases({ network: 'mainnet' }).length, 0);
  repository.close();
});

test('collector retains a case through failure and advances absence only after recovery', async () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const [offense] = parseOffenseSnapshot([OFFENSE_A]);
  repository.recordSuccessfulPoll([offense], {
    observedAt: 2_000,
    network: 'mainnet',
  });

  let now = 3_000;
  const replies = [new Error('connection refused'), []];
  const collector = new OffenseCollector({
    client: {
      async getNodeInfo() {
        return { l1ChainId: 1, registryAddress: REGISTRY, rollupAddress: ROLLUP };
      },
      async getNodeSyncStatus() {
        return {
          ready: true,
          l1Timestamp: String(Math.floor(now / 1_000)),
          l2Slot: '1000',
          l2Epoch: '100',
        };
      },
      async getAllSlashOffenses() {
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    repository,
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    pollIntervalMs: 1_000,
    maxBackoffMs: 2_000,
    withdrawAfterMissedPolls: 2,
    logger: silentLogger,
    now: () => now,
  });

  assert.equal((await collector.runOnce()).ok, false);
  assert.deepEqual(offenseState(repository, offense.id), { status: 'active', missedPolls: 0 });
  now = 4_000;
  assert.equal((await collector.runOnce()).ok, true);
  assert.deepEqual(offenseState(repository, offense.id), { status: 'active', missedPolls: 1 });
  assert.equal(repository.listCases({ network: 'mainnet' })[0].state.stage, 'awaiting_round');
  repository.close();
});

test('collector restarts offense tracking when the canonical Rollup is replaced', async () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), { observedAt: 1_000 });
  const [offense] = parseOffenseSnapshot([OFFENSE_A]);
  repository.recordSuccessfulPoll([offense], { observedAt: 2_000, network: 'mainnet' });
  // A cursor written before rollup tracking, from a Rollup that reached far
  // higher slots than the new one.
  repository.recordSourceSuccess('aztec_sync', {
    version: 1,
    l1Timestamp: '2',
    l2Slot: '5000',
    l2Epoch: '500',
    lastObservedAt: 2_000,
    lastSlotProgressAt: 2_000,
    lastEpochProgressAt: 2_000,
    lastAbsenceSlot: '5000',
    lastAbsenceEpoch: '500',
  }, 2_000);

  const collector = new OffenseCollector({
    client: {
      async getNodeInfo() {
        return { l1ChainId: 1, registryAddress: REGISTRY, rollupAddress: ROLLUP };
      },
      async getNodeSyncStatus() {
        return { ready: true, l1Timestamp: '3', l2Slot: '280', l2Epoch: '28' };
      },
      async getAllSlashOffenses() {
        return [];
      },
    },
    repository,
    expectedChainId: 1,
    expectedRegistryAddress: REGISTRY,
    pollIntervalMs: 1_000,
    maxBackoffMs: 2_000,
    withdrawAfterMissedPolls: 2,
    logger: silentLogger,
    now: () => 3_000,
  });

  const result = await collector.runOnce();
  assert.equal(result.ok, true, result.error);
  assert.equal(
    repository.db.prepare('SELECT COUNT(*) AS count FROM offense_state').get().count,
    0,
    'offenses of the replaced Rollup are no longer tracked',
  );
  const cursor = repository.getSourceState('aztec_sync').metadata;
  assert.equal(cursor.rollupAddress, ROLLUP);
  assert.equal(cursor.l2Slot, '280');
  assert.equal(repository.listCases({ network: 'mainnet' }).length, 1, 'its case history is kept');
  repository.close();
});

function offenseState(repository, id) {
  const row = repository.db.prepare(`
    SELECT status, missed_polls AS missedPolls FROM offense_state WHERE id = ?
  `).get(id);
  return { status: row.status, missedPolls: Number(row.missedPolls) };
}
