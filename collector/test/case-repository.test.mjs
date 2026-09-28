import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { CaseRepository } from '../src/case-repository.mjs';
import { parseOffenseSnapshot } from '../src/offenses.mjs';
import { createRepository, protocolSnapshot, targetRound } from './case-fixtures.mjs';

const REGISTRY = '0x1111111111111111111111111111111111111111';
const ROLLUP = '0x2222222222222222222222222222222222222222';
const SLASHER = '0x3333333333333333333333333333333333333333';
const PROPOSER = '0x4444444444444444444444444444444444444444';
const SEQUENCER = '0x5555555555555555555555555555555555555555';
const PAYLOAD = '0x6666666666666666666666666666666666666666';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;

test('CaseRepository projects transitions and queues only matching watched sequencers', () => {
  const repository = createRepository();
  repository.createWatch({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    managementTokenHash: 'hash',
    network: 'mainnet',
    addresses: [SEQUENCER],
    now: 1_700_000_000_000,
  });
  repository.upsertEndpoint({
    watchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'telegram',
    destination: '1234',
    now: 1_700_000_000_000,
  });

  const first = repository.recordObservations([
    observation('inactive', 'inactivity_epoch', {
      epoch: 8,
      missed: 8,
      total: 10,
      streak: 1,
      threshold: 2,
      targetPercentage: 0.8,
    }),
  ], { protocol: protocol() });
  assert.equal(first.transitions, 1);
  assert.equal(first.queued, 1);
  assert.equal(repository.getSequencerRecord(SEQUENCER, 'mainnet').cases[0].state.headline,
    '1 of 2 qualifying inactive epochs');

  const duplicate = repository.recordObservations([
    observation('inactive', 'inactivity_epoch', {
      epoch: 8,
      missed: 8,
      total: 10,
      streak: 1,
      threshold: 2,
      targetPercentage: 0.8,
    }),
  ]);
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.transitions, 0);

  const offense = repository.recordObservations([
    observation('offense', 'node_offense', {
      offenseTypeName: 'inactivity',
      status: 'active',
      amount: '1000000000000000000',
      expectedRound: '10',
    }),
  ]);
  assert.equal(offense.transitions, 1);
  assert.equal(repository.getSequencerRecord(SEQUENCER, 'mainnet').cases[0].state.stage,
    'awaiting_round');
  repository.close();
});

test('L1 ballots queue only the first vote and quorum', () => {
  const repository = createRepository();
  repository.createWatch({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    managementTokenHash: 'hash',
    network: 'mainnet',
    addresses: [SEQUENCER],
    now: 1_700_000_000_000,
  });
  repository.upsertEndpoint({
    watchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'telegram',
    destination: '1234',
    now: 1_700_000_000_000,
  });

  const firstVote = repository.recordObservations([
    l1Vote('vote-1', '2023-11-14T22:15:20.000Z', 1),
  ], { protocol: protocol() });
  assert.equal(firstVote.transitions, 1);
  assert.equal(firstVote.queued, 1);

  const secondVote = repository.recordObservations([
    l1Vote('vote-2', '2023-11-14T22:16:20.000Z', 2),
  ]);
  assert.equal(secondVote.transitions, 0);
  assert.equal(secondVote.queued, 0);

  const quorum = repository.recordObservations([
    l1Vote('quorum', '2023-11-14T22:17:20.000Z', 2, '100'),
  ]);
  assert.equal(quorum.transitions, 1);
  assert.equal(quorum.queued, 1);

  const item = repository.getCase(repository.listCases({ network: 'mainnet' })[0].id);
  assert.equal(item.state.stage, 'candidate');
  assert.deepEqual(item.transitions.map((transition) => transition.toStage), [
    'l1_support',
    'candidate',
  ]);
  repository.close();
});

test('L1 snapshots preserve a repeated sequencer as two exact target-epoch cases', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', {
    chainId: 1,
    blockNumber: '100',
    blockHash: BLOCK_HASH,
    blockTimestamp: '1700000100',
    observedAt: 1_700_000_100_000,
    registryAddress: REGISTRY,
    rollupAddress: ROLLUP,
    l1GenesisTime: '1700000000',
    currentSlot: '100',
    currentEpoch: '10',
    slotDuration: '12',
    epochDuration: '10',
    stacks: [{
      role: 'active',
      rollupAddress: ROLLUP,
      slasherAddress: SLASHER,
      proposerAddress: PROPOSER,
      currentRound: '10',
      isSlashingEnabled: true,
      slashingDisabledUntil: '0',
      parameters: {
        quorum: '2',
        roundSize: '20',
        roundSizeInEpochs: '2',
        executionDelayInRounds: '2',
        lifetimeInRounds: '4',
        slashOffsetInRounds: '1',
        committeeSize: '4',
      },
      rounds: [{
        round: '10',
        status: 'quorum-reached',
        isExecuted: false,
        isVetoed: false,
        isExecutionPaused: false,
        isProtected: false,
        payloadAddress: '0x6666666666666666666666666666666666666666',
        executableSlot: '260',
        expirySlot: '300',
        actions: [
          { sequencer: SEQUENCER, amount: '100' },
          { sequencer: SEQUENCER, amount: '300' },
        ],
        earlyTargets: [],
        actionDetails: [
          {
            sequencer: SEQUENCER,
            targetEpoch: '18',
            epochIndex: 0,
            committeeIndex: 0,
            voteCount: 2,
            support: 2,
            maxSlashUnits: 1,
            unitVoteCounts: [2, 0, 0],
            amount: '100',
          },
          {
            sequencer: SEQUENCER,
            targetEpoch: '19',
            epochIndex: 1,
            committeeIndex: 0,
            voteCount: 2,
            support: 2,
            maxSlashUnits: 3,
            unitVoteCounts: [0, 0, 2],
            amount: '300',
          },
        ],
      }],
    }],
  });
  const cases = repository.getSequencerRecord(SEQUENCER, 'mainnet').cases;
  assert.deepEqual(cases.map((item) => item.targetEpoch).sort(), ['18', '19']);
  assert.deepEqual(
    cases.map((item) => item.state.requestedAmount).sort(),
    ['100', '300'],
  );
  repository.close();
});

test('a repeated sequencer slash uses receipt action order to select the exact epoch', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    rounds: [{
      ...targetRound({ sequencer: SEQUENCER, targetEpoch: '18', amount: '100' }),
      actions: [
        { sequencer: SEQUENCER, amount: '100' },
        { sequencer: SEQUENCER, amount: '300' },
      ],
      actionDetails: [
        {
          ...targetRound({
            sequencer: SEQUENCER,
            targetEpoch: '18',
            amount: '100',
          }).actionDetails[0],
          actionIndex: 0,
        },
        {
          ...targetRound({
            sequencer: SEQUENCER,
            targetEpoch: '19',
            amount: '300',
          }).actionDetails[0],
          actionIndex: 1,
        },
      ],
    }],
  }));
  repository.recordSuccessfulL1SlashLogChunk('mainnet', {
    fromBlock: '101',
    toBlock: '101',
    toBlockHash: BLOCK_HASH,
    confirmedBlockNumber: '101',
    rollupAddresses: [ROLLUP],
    initialBackfill: false,
    hasMore: false,
    reorgDetected: false,
    logs: [{
      rollupAddress: ROLLUP,
      blockNumber: '101',
      blockHash: BLOCK_HASH,
      transactionHash: `0x${'cd'.repeat(32)}`,
      logIndex: 2,
      transactionSlashIndex: 1,
      sequencer: SEQUENCER,
      amount: '250',
      executionCandidates: [{ proposerAddress: PROPOSER, round: '14' }],
      ejected: false,
    }],
  });
  const cases = repository.getSequencerRecord(SEQUENCER, 'mainnet').cases;
  assert.equal(
    cases.find((item) => item.targetEpoch === '19').state.stage,
    'stake_removed',
  );
  assert.equal(
    cases.find((item) => item.targetEpoch === '18').state.stage,
    'candidate',
  );
  repository.close();
});

test('historical slash backfill creates exact missing rounds for a repeated sequencer', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot());
  const transaction = `0x${'cd'.repeat(32)}`;
  const contexts = [
    historicalContext({ targetEpoch: '24', actionIndex: 0, amount: '100' }),
    historicalContext({ targetEpoch: '25', actionIndex: 1, amount: '300' }),
  ];

  repository.recordSuccessfulL1SlashLogChunk('mainnet', {
    fromBlock: '101',
    toBlock: '101',
    toBlockHash: BLOCK_HASH,
    confirmedBlockNumber: '101',
    rollupAddresses: [ROLLUP],
    initialBackfill: true,
    hasMore: true,
    reorgDetected: false,
    logs: contexts.map((executionContext, actionIndex) => ({
      rollupAddress: ROLLUP,
      blockNumber: '101',
      blockHash: BLOCK_HASH,
      transactionHash: transaction,
      logIndex: 151 + actionIndex,
      transactionSlashIndex: actionIndex,
      sequencer: SEQUENCER,
      amount: actionIndex === 0 ? '90' : '250',
      executionCandidates: [{ proposerAddress: PROPOSER, round: '14' }],
      executionContext,
      ejected: false,
    })),
  });

  const cases = repository.getSequencerRecord(SEQUENCER, 'mainnet').cases
    .sort((left, right) => left.targetEpoch.localeCompare(right.targetEpoch));
  assert.deepEqual(cases.map((item) => ({
    targetEpoch: item.targetEpoch,
    stage: item.state.stage,
    requestedAmount: item.state.requestedAmount,
    actualAmount: item.state.actualAmount,
  })), [
    {
      targetEpoch: '24',
      stage: 'stake_removed',
      requestedAmount: null,
      actualAmount: '90',
    },
    {
      targetEpoch: '25',
      stage: 'stake_removed',
      requestedAmount: null,
      actualAmount: '250',
    },
  ]);
  for (const item of cases) {
    const stored = repository.getCase(item.id);
    const historicalRound = stored.observations.find(
      (observation) => observation.kind === 'l1_round',
    );
    assert.equal(historicalRound.data.historicalExecution, true);
    assert.equal(historicalRound.data.payloadAddress, PAYLOAD);
    assert.equal(
      stored.observations.find((observation) => observation.kind === 'l1_slash')
        .provenance.transactionHash,
      transaction,
    );
  }
  repository.close();
});

test('L1 target removal and restoration produce one corrected case lineage', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [targetRound({ sequencer: SEQUENCER, targetEpoch: '24' })],
  }));
  assert.equal(repository.listCases({ network: 'mainnet' })[0].state.stage, 'candidate');

  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 101,
    rounds: [{
      ...targetRound({ sequencer: SEQUENCER, targetEpoch: '24', amount: null }),
      actionDetails: [],
    }],
  }));
  assert.equal(repository.listCases({ network: 'mainnet' })[0].state.stage, 'reorged');

  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 102,
    rounds: [targetRound({ sequencer: SEQUENCER, targetEpoch: '24' })],
  }));
  const restored = repository.listCases({ network: 'mainnet' })[0];
  assert.equal(restored.state.stage, 'candidate');
  assert.equal(repository.getCase(restored.id).transitions.length, 3);
  repository.close();
});

test('withdrawn node evidence can reactivate the same exact offense case', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot(), {
    observedAt: 1_000,
  });
  const [offense] = parseOffenseSnapshot([{
    validator: SEQUENCER,
    amount: '1000',
    offenseType: 3,
    epochOrSlot: '26',
  }]);
  repository.recordSuccessfulPoll([offense], {
    network: 'mainnet',
    observedAt: 2_000,
  });
  repository.recordSuccessfulPoll([], {
    network: 'mainnet',
    observedAt: 3_000,
    withdrawAfterMissedPolls: 1,
    absenceEvidence: {
      epoch: { advanced: true, value: '27' },
      slot: { advanced: false, value: '0' },
    },
  });
  assert.equal(repository.listCases({ network: 'mainnet' })[0].state.stage, 'resolved');

  repository.recordSuccessfulPoll([offense], {
    network: 'mainnet',
    observedAt: 4_000,
  });
  const reactivated = repository.listCases({ network: 'mainnet' })[0];
  assert.equal(reactivated.state.stage, 'node_offense');
  assert.deepEqual(
    reactivated.observations.map((item) => item.data.status),
    ['active', 'withdrawn', 'active'],
  );
  repository.close();
});

test('repository refuses a nonempty incompatible database instead of migrating it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slashmon-schema-'));
  const databasePath = path.join(directory, 'incompatible.sqlite');
  try {
    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec('CREATE TABLE events(id TEXT PRIMARY KEY); PRAGMA user_version = 1');
    incompatible.close();
    assert.throws(
      () => new CaseRepository(databasePath),
      /requires an empty database or its exact current schema/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('repository reopens only an exact database owned by slashveto.me', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slashmon-schema-'));
  const databasePath = path.join(directory, 'slashmon.sqlite');
  try {
    new CaseRepository(databasePath).close();
    assert.doesNotThrow(() => new CaseRepository(databasePath).close());

    const altered = new DatabaseSync(databasePath);
    altered.exec('CREATE TABLE unrelated(value TEXT)');
    altered.close();
    assert.throws(
      () => new CaseRepository(databasePath),
      /requires an empty database or its exact current schema/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('superseded round snapshots replace stored evidence instead of accumulating', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [targetRound({ sequencer: SEQUENCER, targetEpoch: '24' })],
  }));
  const initial = repository.listCases({ network: 'mainnet' })[0];

  const grown = targetRound({ sequencer: SEQUENCER, targetEpoch: '24' });
  grown.ballotCount = '3';
  grown.actionDetails[0].voteCount = 3;
  grown.actionDetails[0].support = 3;
  grown.actionDetails[0].unitVoteCounts = [3, 0, 0];
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 101,
    rounds: [grown],
  }));

  const updated = repository.listCases({ network: 'mainnet' })[0];
  const rounds = updated.observations.filter((item) => item.kind === 'l1_round');
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].data.support, 3);
  assert.equal(rounds[0].provenance.canonical, true);
  assert.equal(updated.firstObservedAt, initial.firstObservedAt);
  assert.equal(
    repository.db.prepare(
      'SELECT COUNT(*) AS stale FROM observations WHERE canonical = 0',
    ).get().stale,
    0,
  );
  repository.close();
});

test('boot prune deletes legacy superseded rounds and keeps corrections', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [targetRound({ sequencer: SEQUENCER, targetEpoch: '24' })],
  }));
  const current = repository.listCases({ network: 'mainnet' })[0];
  const canonical = current.observations.find((item) => item.kind === 'l1_round');

  // Recreate the pre-cleanup database layout: an older vote-state row for the
  // same round that used to be kept as canonical = 0, plus a correction
  // tombstone in another case with no canonical replacement.
  const legacy = structuredClone(canonical);
  legacy.id = 'legacy-superseded-round';
  legacy.data.support = 1;
  legacy.provenance.observedAt = '2023-11-14T20:00:00.000Z';
  legacy.provenance.canonical = false;
  legacy.provenance.invalidatedAt = canonical.provenance.observedAt;
  const tombstone = structuredClone(legacy);
  tombstone.id = 'legacy-reorged-round';
  tombstone.targetEpoch = '25';
  insertRawObservation(repository, legacy);
  insertRawObservation(repository, tombstone);
  const tombstoneCaseId = `case:mainnet:${PROPOSER}:${SEQUENCER}:25`;
  repository.reprojectCases([current.id, tombstoneCaseId], { notify: false });
  assert.equal(
    repository.listCases({ network: 'mainnet' }).length,
    2,
  );

  const result = repository.pruneSupersededRoundObservations();
  assert.deepEqual(result, { pruned: 1, casesChanged: 1 });

  const cases = repository.listCases({ network: 'mainnet' });
  const pruned = cases.find((item) => item.id === current.id);
  assert.equal(pruned.observations.length, 1);
  assert.equal(pruned.observations[0].provenance.canonical, true);
  assert.equal(pruned.firstObservedAt, '2023-11-14T20:00:00.000Z');
  const correction = cases.find((item) => item.id === tombstoneCaseId);
  assert.equal(correction.state.stage, 'reorged');
  assert.equal(correction.observations.length, 1);
  assert.equal(repository.pruneSupersededRoundObservations().pruned, 0);
  repository.close();
});

// With the fixture clock at round 14, a round targets epochs
// (round - 1) * 2 and the one after; lifetime ends after round + 4.
test('a round advance closes open cases and alerts only for warned evidence', () => {
  const repository = createRepository();
  watchWithTelegram(repository);
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({ block: 100 }));
  repository.recordObservations([dutyObservation('26', '2023-11-14T22:20:00.000Z')]);
  const [offense] = parseOffenseSnapshot([{
    validator: SEQUENCER,
    amount: '1000',
    offenseType: 3,
    epochOrSlot: '27',
  }]);
  repository.recordSuccessfulPoll([offense], { network: 'mainnet', observedAt: 2_000 });
  assert.deepEqual(openStages(repository), ['node_offense', 'precursor']);
  const queuedBefore = countDeliveries(repository);

  const sameRound = repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 101,
  }));
  assert.equal(sameRound.changed, 0);

  const advanced = repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 102,
    currentRound: 15,
    currentSlot: 300,
    currentEpoch: 30,
  }));
  assert.equal(advanced.changed, 2);
  assert.equal(advanced.transitions, 1);
  assert.equal(advanced.queued, 1);
  assert.equal(countDeliveries(repository), queuedBefore + 1);
  assert.deepEqual(openStages(repository), []);

  const closedOffense = repository.listCases({ network: 'mainnet' })
    .find((item) => item.targetEpoch === '27');
  assert.equal(closedOffense.state.stage, 'resolved');
  const closing = repository.getCase(closedOffense.id).transitions.at(-1);
  assert.equal(closing.toStage, 'resolved');
  assert.equal(closing.observedAt, repository.getProtocolSnapshot().observedAt);
  repository.close();
});

test('a candidate expires once its round leaves the scanned lifetime', () => {
  const repository = createRepository();
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [targetRound({ sequencer: SEQUENCER, targetEpoch: '26', status: 'executable' })],
  }));
  assert.deepEqual(openStages(repository), ['executable']);

  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 101,
    currentRound: 19,
    currentSlot: 380,
    currentEpoch: 38,
  }));
  const [expired] = repository.listCases({ network: 'mainnet' });
  assert.equal(expired.state.stage, 'expired');
  assert.equal(expired.state.active, false);
  assert.match(
    repository.getCase(expired.id).transitions.at(-1).body,
    /Event: Slash candidate expired/,
  );
  repository.close();
});

test('boot reprojects open cases against the stored clock without alerting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slashmon-clock-'));
  const databasePath = path.join(directory, 'slashmon.sqlite');
  try {
    const before = new CaseRepository(databasePath);
    watchWithTelegram(before);
    before.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({ block: 100 }));
    before.recordObservations([dutyObservation('26', '2023-11-14T22:20:00.000Z')]);
    // A database written before cases closed by protocol time: the clock
    // moved on while the stored projection stayed open.
    const protocol = before.getProtocolSnapshot();
    protocol.lineages[0].currentRound = '15';
    before.setProtocolSnapshot(protocol);
    assert.deepEqual(openStages(before), ['precursor']);
    const queued = countDeliveries(before);
    before.close();

    const after = new CaseRepository(databasePath);
    assert.equal(after.clockResult.changed, 1);
    assert.equal(after.clockResult.queued, 0);
    assert.deepEqual(openStages(after), []);
    assert.equal(countDeliveries(after), queued);
    after.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('watched cases drop closed cases that never reached quorum after retention', () => {
  const repository = createRepository();
  const lastEvidence = Date.parse('2023-11-14T22:20:00.000Z');
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [
      targetRound({ sequencer: SEQUENCER, targetEpoch: '26' }),
      { ...targetRound({ sequencer: SEQUENCER, targetEpoch: '24', round: '13' }), isVetoed: true },
    ],
  }));
  repository.recordObservations([dutyObservation('25', new Date(lastEvidence).toISOString())]);
  const stages = (closedSince) => repository
    .getSequencerCases('mainnet', [SEQUENCER], { closedSince })
    .map((item) => `${item.targetEpoch}:${item.state.stage}`)
    .sort();

  assert.deepEqual(stages(lastEvidence), ['24:vetoed', '25:resolved', '26:candidate']);
  assert.deepEqual(stages(lastEvidence + 1), ['24:vetoed', '26:candidate']);
  const closedId = `case:mainnet:${PROPOSER}:${SEQUENCER}:25`;
  assert.equal(repository.getCase(closedId).state.stage, 'resolved');
  assert.equal(repository.getSequencerRecord(SEQUENCER, 'mainnet').cases.length, 3);
  repository.close();
});

test('the network feed sends open cases and recent outcomes, summarizing retained ones', () => {
  const repository = createRepository();
  const executed = (round, targetEpoch) => targetRound({
    sequencer: SEQUENCER,
    targetEpoch,
    round,
    executed: true,
  });
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 99,
    rounds: [executed('9', '19')],
  }));
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [
      ...['10', '11', '12', '13'].map((round, index) => executed(round, String(20 + index))),
      targetRound({ sequencer: SEQUENCER, targetEpoch: '26' }),
    ],
  }));

  // Executed rounds without a Slashed log stay "executed". The feed keeps the
  // open candidate and the RECENT_EXECUTION_LIMIT latest-observed outcomes.
  const feed = repository.getNetworkSummary('mainnet', { closedSince: 0 });
  assert.deepEqual(
    feed.cases.map((item) => `${item.targetEpoch}:${item.state.stage}`),
    ['26:candidate', '20:executed', '21:executed', '22:executed', '23:executed'],
  );
  assert.equal(feed.summary.candidates, 1);
  assert.equal(repository.getSequencerCases('mainnet', [SEQUENCER], { closedSince: 0 }).length, 6);
  repository.close();
});

test('history pruning deletes old closed cases without quorum and old duty rows', () => {
  const repository = createRepository();
  const lastEvidence = Date.parse('2023-11-14T22:20:00.000Z');
  const retention = 90 * 24 * 60 * 60_000;
  repository.recordSuccessfulL1Snapshot('mainnet', protocolSnapshot({
    block: 100,
    rounds: [
      targetRound({ sequencer: SEQUENCER, targetEpoch: '26' }),
      { ...targetRound({ sequencer: SEQUENCER, targetEpoch: '24', round: '13' }), isVetoed: true },
    ],
  }));
  repository.recordObservations([dutyObservation('25', new Date(lastEvidence).toISOString())]);
  for (const epoch of [1, 2, 3]) {
    repository.db.prepare(`
      INSERT INTO sentinel_epoch_index(epoch, coverage_generation, indexed_at)
      VALUES (?, 0, ?)
    `).run(epoch, lastEvidence);
    repository.db.prepare(`
      INSERT INTO sentinel_performance (
        sequencer, epoch, missed, total, inactive, streak, threshold,
        target_percentage, coverage_generation
      ) VALUES (?, ?, 0, 1, 0, 0, 2, 0.8, 0)
    `).run(SEQUENCER, epoch);
  }

  assert.deepEqual(repository.pruneExpiredData({ now: lastEvidence + retention }), {
    deliveries: 0,
    telegramLinks: 0,
    cases: 0,
    observations: 0,
    sentinelEpochs: 0,
    sentinelRows: 0,
  });
  const version = repository.casesVersion;
  assert.deepEqual(repository.pruneHistory({ now: lastEvidence + retention + 1 }), {
    cases: 1,
    observations: 1,
    sentinelEpochs: 2,
    sentinelRows: 2,
  });
  assert.ok(repository.casesVersion > version);
  assert.equal(repository.getCase(`case:mainnet:${PROPOSER}:${SEQUENCER}:25`), null);
  assert.deepEqual(
    repository.getSequencerRecord(SEQUENCER, 'mainnet').cases
      .map((item) => item.state.stage).sort(),
    ['candidate', 'vetoed'],
  );
  assert.equal(repository.getValidatorIndexCursor().epoch, 3);
  assert.equal(
    repository.db.prepare('SELECT COUNT(*) AS count FROM sentinel_performance').get().count,
    1,
  );
  repository.close();
});

function watchWithTelegram(repository) {
  repository.createWatch({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    managementTokenHash: 'hash',
    network: 'mainnet',
    addresses: [SEQUENCER],
    now: 1_700_000_000_000,
  });
  repository.upsertEndpoint({
    watchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    kind: 'telegram',
    destination: '1234',
    now: 1_700_000_000_000,
  });
}

function dutyObservation(targetEpoch, observedAt) {
  return {
    id: `duty-${targetEpoch}`,
    network: 'mainnet',
    source: 'aztec_sentinel',
    kind: 'duty_miss',
    sequencer: SEQUENCER,
    lineageId: PROPOSER,
    targetEpoch,
    provenance: { observedAt, canonical: true },
    data: { epoch: Number(targetEpoch), status: 'attestation-missed' },
  };
}

function openStages(repository) {
  return repository.listCases({ network: 'mainnet', active: true })
    .map((item) => item.state.stage)
    .sort();
}

function countDeliveries(repository) {
  return Number(repository.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count);
}

function insertRawObservation(repository, observation) {
  repository.db.prepare(`
    INSERT INTO observations (
      id, network, source, kind, sequencer, lineage_id, target_epoch,
      slot, round, observed_at, block_number, block_hash, transaction_hash,
      canonical, observation_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observation.id,
    observation.network,
    observation.source,
    observation.kind,
    observation.sequencer,
    observation.lineageId,
    observation.targetEpoch,
    observation.slot ?? null,
    observation.round ?? null,
    Date.parse(observation.provenance.observedAt),
    observation.provenance.blockNumber ?? null,
    observation.provenance.blockHash ?? null,
    observation.provenance.transactionHash ?? null,
    Number(observation.provenance.canonical),
    JSON.stringify(observation),
  );
}

function historicalContext({ targetEpoch, actionIndex, amount }) {
  return {
    proposerAddress: PROPOSER,
    round: '14',
    targetEpoch,
    actionIndex,
    sequencer: SEQUENCER,
    amount,
    support: 2,
    quorum: 2,
    maxSlashUnits: actionIndex + 1,
    unitVoteCounts: actionIndex === 0 ? [2, 0, 0] : [0, 2, 0],
    epochIndex: actionIndex,
    committeeIndex: 0,
    escaped: false,
    payloadAddress: PAYLOAD,
  };
}

function protocol() {
  return {
    network: 'mainnet',
    chainId: 1,
    observedAt: '2023-11-14T22:13:20.000Z',
    blockNumber: '100',
    blockHash: BLOCK_HASH,
    registryAddress: REGISTRY,
    rollupAddress: ROLLUP,
    genesisTime: '1700000000',
    currentSlot: '100',
    currentEpoch: '10',
    slotDurationSeconds: 12,
    epochDurationSlots: 10,
    inactivity: { targetPercentage: 0.8, consecutiveEpochs: 2 },
    lineages: [{
      role: 'active',
      rollupAddress: ROLLUP,
      slasherAddress: SLASHER,
      proposerAddress: PROPOSER,
      currentRound: '9',
      isSlashingEnabled: true,
      disabledUntil: null,
      parameters: {
        quorum: 2,
        roundSizeSlots: 20,
        roundSizeEpochs: 2,
        executionDelayRounds: 2,
        lifetimeRounds: 4,
        slashOffsetRounds: 6,
        committeeSize: 4,
      },
    }],
  };
}

function observation(id, kind, data) {
  return {
    id,
    network: 'mainnet',
    source: kind === 'node_offense' ? 'aztec_node' : 'aztec_sentinel',
    kind,
    sequencer: SEQUENCER,
    lineageId: PROPOSER,
    targetEpoch: '8',
    provenance: {
      observedAt: id === 'inactive'
        ? '2023-11-14T22:13:20.000Z'
        : '2023-11-14T22:14:20.000Z',
      canonical: true,
    },
    data,
  };
}

function l1Vote(id, observedAt, support, amount = null) {
  return {
    id,
    network: 'mainnet',
    source: 'ethereum_l1',
    kind: 'l1_round',
    sequencer: SEQUENCER,
    lineageId: PROPOSER,
    targetEpoch: '8',
    round: '10',
    provenance: {
      observedAt,
      blockNumber: '100',
      blockHash: BLOCK_HASH,
      canonical: true,
    },
    data: {
      round: '10',
      status: amount ? 'quorum-reached' : 'below-quorum',
      support,
      quorum: 2,
      amount,
      payloadAddress: amount ? PAYLOAD : null,
      isExecuted: false,
      isVetoed: false,
      stable: false,
      escaped: false,
    },
  };
}
