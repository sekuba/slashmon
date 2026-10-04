// Pure observation and protocol-snapshot builders. Everything here validates
// scanner/node input into the plain-JSON observation shapes consumed by the
// shared case projection; only findExecutionForSlash reads the database, and
// it receives the handle explicitly.

import {
  address,
  hash,
  network,
  parseJson,
  positiveInteger,
  stableId,
  toIso,
  unsignedInteger,
  unsignedString,
} from './validate.mjs';

const MISSED_DUTIES = new Set([
  'checkpoint-invalid',
  'checkpoint-unvalidated',
  'checkpoint-missed',
  'blocks-missed',
  'attestation-missed',
]);
const DUTY_STATUSES = new Set([
  'checkpoint-mined',
  'checkpoint-valid',
  'checkpoint-invalid',
  'checkpoint-unvalidated',
  'checkpoint-missed',
  'blocks-missed',
  'attestation-sent',
  'attestation-missed',
]);

export function protocolFromL1Snapshot(selectedNetwork, snapshot, inactivity) {
  return {
    network: network(selectedNetwork),
    chainId: positiveInteger(snapshot.chainId, 'chain id'),
    observedAt: toIso(snapshot.blockTimestamp ?? snapshot.observedAt),
    blockNumber: unsignedString(snapshot.blockNumber, 'block number'),
    blockHash: hash(snapshot.blockHash, 'block hash'),
    registryAddress: address(snapshot.registryAddress, 'Registry'),
    rollupAddress: address(snapshot.rollupAddress, 'Rollup'),
    genesisTime: unsignedString(snapshot.l1GenesisTime, 'genesis time'),
    currentSlot: unsignedString(snapshot.currentSlot, 'current slot'),
    currentEpoch: unsignedString(snapshot.currentEpoch, 'current epoch'),
    slotDurationSeconds: positiveInteger(snapshot.slotDuration, 'slot duration'),
    epochDurationSlots: positiveInteger(snapshot.epochDuration, 'epoch duration'),
    lineages: (snapshot.stacks ?? []).map((stack) => ({
      role: stack.role,
      rollupAddress: address(stack.rollupAddress ?? snapshot.rollupAddress, 'Rollup'),
      slasherAddress: address(stack.slasherAddress, 'Slasher'),
      proposerAddress: address(stack.proposerAddress, 'SlashingProposer'),
      currentRound: unsignedString(stack.currentRound, 'current round'),
      isSlashingEnabled: Boolean(stack.isSlashingEnabled),
      disabledUntil: BigInt(stack.slashingDisabledUntil ?? 0) === 0n
        ? null
        : unsignedString(stack.slashingDisabledUntil, 'disabled until'),
      parameters: {
        quorum: positiveInteger(stack.parameters.quorum, 'quorum'),
        roundSizeSlots: positiveInteger(stack.parameters.roundSize, 'round size'),
        roundSizeEpochs: positiveInteger(
          stack.parameters.roundSizeInEpochs,
          'round size in epochs',
        ),
        executionDelayRounds: unsignedInteger(
          stack.parameters.executionDelayInRounds,
          'execution delay',
        ),
        lifetimeRounds: positiveInteger(stack.parameters.lifetimeInRounds, 'lifetime'),
        slashOffsetRounds: unsignedInteger(
          stack.parameters.slashOffsetInRounds,
          'slash offset',
        ),
        committeeSize: positiveInteger(stack.parameters.committeeSize, 'committee size'),
        slashAmounts: Array.isArray(stack.parameters.slashAmounts)
          ? stack.parameters.slashAmounts.map((amount) =>
            unsignedString(amount, 'slash amount'))
          : null,
      },
    })),
    inactivity,
    staking: snapshot.staking
      ? {
        activationThreshold: unsignedString(
          snapshot.staking.activationThreshold,
          'activation threshold',
        ),
        localEjectionThreshold: unsignedString(
          snapshot.staking.localEjectionThreshold,
          'local ejection threshold',
        ),
        exitDelaySeconds: unsignedInteger(snapshot.staking.exitDelay, 'exit delay'),
      }
      : null,
  };
}

export function observationsFromL1Snapshot(selectedNetwork, snapshot, protocol) {
  const result = [];
  for (const stack of snapshot.stacks ?? []) {
    const lineage = protocol.lineages.find((item) =>
      item.proposerAddress === String(stack.proposerAddress).toLowerCase());
    if (!lineage) continue;
    for (const round of stack.rounds ?? []) {
      const actions = round.actionDetails ?? [];
      const byPosition = new Map(actions.map((detail) => [
        targetPosition(detail),
        detail,
      ]));
      const details = (round.earlyTargets ?? []).map((target) => ({
        ...target,
        ...byPosition.get(targetPosition(target)),
      }));
      const present = new Set(details.map(targetPosition));
      details.push(...actions.filter((detail) => !present.has(targetPosition(detail))));
      for (const detail of details) {
        if (detail.targetEpoch === undefined || detail.targetEpoch === null) continue;
        const sequencer = address(detail.sequencer, 'slash target');
        const targetEpoch = unsignedString(detail.targetEpoch, 'target epoch');
        const data = {
          round: unsignedString(round.round, 'round'),
          status: String(round.status),
          support: Number(detail.voteCount ?? detail.support ?? 0),
          quorum: lineage.parameters.quorum,
          amount: detail.amount === undefined || detail.amount === null
            ? null
            : unsignedString(detail.amount, 'slash amount'),
          actionIndex: detail.actionIndex === undefined
            ? null
            : Number(detail.actionIndex),
          maxSlashUnits: Number(detail.maxSlashUnits ?? 0),
          unitVoteCounts: detail.unitVoteCounts ?? [0, 0, 0],
          escaped: Boolean(detail.escaped),
          payloadAddress: round.payloadAddress
            ? address(round.payloadAddress, 'payload')
            : null,
          isVetoed: Boolean(round.isVetoed),
          isExecuted: Boolean(round.isExecuted),
          stable: BigInt(lineage.currentRound) > BigInt(round.round),
          isExecutionPaused: Boolean(round.isExecutionPaused),
          isProtected: Boolean(round.isProtected),
          roundEndSlot: (
            (BigInt(round.round) + 1n) * BigInt(lineage.parameters.roundSizeSlots)
          ).toString(),
          executableSlot: unsignedString(round.executableSlot, 'executable slot'),
          expirySlot: unsignedString(round.expirySlot, 'expiry slot'),
        };
        data.roundEndAt = slotTime(protocol, data.roundEndSlot);
        data.executableAt = slotTime(protocol, data.executableSlot);
        data.expiryAt = slotTime(protocol, data.expirySlot);
        result.push({
          id: stableId(
            'l1-round',
            lineage.proposerAddress,
            round.round,
            sequencer,
            targetEpoch,
            JSON.stringify(data),
          ),
          network: network(selectedNetwork),
          source: 'ethereum_l1',
          kind: 'l1_round',
          sequencer,
          lineageId: lineage.proposerAddress,
          targetEpoch,
          round: String(round.round),
          provenance: {
            observedAt: protocol.observedAt,
            blockNumber: protocol.blockNumber,
            blockHash: protocol.blockHash,
            canonical: true,
          },
          data,
        });
      }
    }
  }
  return result;
}

export function targetPosition(target) {
  return [
    Number(target.epochIndex),
    Number(target.committeeIndex),
    String(target.sequencer).toLowerCase(),
  ].join(':');
}

export function findExecutionForSlash(db, log) {
  const candidates = log.executionCandidates ??
    (log.proposerAddress && log.round !== undefined
      ? [{ proposerAddress: log.proposerAddress, round: log.round }]
      : []);
  for (const candidate of candidates) {
    const row = db.prepare(`
      SELECT observation_json AS observationJson FROM observations
      WHERE kind = 'l1_round' AND lineage_id = ? AND round = ?
        AND sequencer = ? AND canonical = 1
        AND json_extract(observation_json, '$.data.actionIndex') = ?
      ORDER BY observed_at DESC LIMIT 1
    `).get(
      address(candidate.proposerAddress, 'SlashingProposer'),
      unsignedString(candidate.round, 'round'),
      address(log.sequencer, 'sequencer'),
      unsignedInteger(log.transactionSlashIndex, 'transaction slash index'),
    );
    if (row) return parseJson(row.observationJson, null);
  }
  return null;
}

export function assertExecutionMatchesContext(execution, log) {
  if (!log.executionContext) return;
  const context = log.executionContext;
  const mismatches = [
    execution.lineageId !== address(context.proposerAddress, 'SlashingProposer'),
    execution.round !== unsignedString(context.round, 'round'),
    execution.sequencer !== address(context.sequencer, 'sequencer'),
    execution.targetEpoch !== unsignedString(context.targetEpoch, 'target epoch'),
    unsignedInteger(execution.data.actionIndex, 'stored action index') !==
      unsignedInteger(context.actionIndex, 'historical action index'),
    execution.data.amount !== unsignedString(context.amount, 'slash amount'),
  ];
  if (mismatches.some(Boolean)) {
    throw new Error(
      `Slashed log ${log.transactionHash}:${log.logIndex} disagrees with its stored RoundExecuted case`,
    );
  }
}

export function historicalRoundObservation({
  network: selectedNetwork,
  log,
  observedAt,
}) {
  const context = log.executionContext;
  const sequencer = address(log.sequencer, 'sequencer');
  const contextSequencer = address(context?.sequencer, 'historical sequencer');
  const actionIndex = unsignedInteger(
    context?.actionIndex,
    'historical action index',
  );
  if (
    contextSequencer !== sequencer ||
    actionIndex !== unsignedInteger(log.transactionSlashIndex, 'transaction slash index')
  ) {
    throw new Error(
      `Slashed log ${log.transactionHash}:${log.logIndex} has inconsistent historical execution context`,
    );
  }
  const lineageId = address(context.proposerAddress, 'SlashingProposer');
  const round = unsignedString(context.round, 'round');
  const targetEpoch = unsignedString(context.targetEpoch, 'target epoch');
  const data = {
    round,
    status: 'executed',
    support: unsignedInteger(context.support, 'slash support'),
    quorum: positiveInteger(context.quorum, 'quorum'),
    amount: unsignedString(context.amount, 'slash amount'),
    actionIndex,
    maxSlashUnits: unsignedInteger(context.maxSlashUnits, 'maximum slash units'),
    unitVoteCounts: (context.unitVoteCounts ?? []).map((value) =>
      unsignedInteger(value, 'unit vote count')),
    escaped: Boolean(context.escaped),
    payloadAddress: address(context.payloadAddress, 'payload'),
    isVetoed: false,
    isExecuted: true,
    stable: true,
    isExecutionPaused: false,
    isProtected: false,
    historicalExecution: true,
  };
  return {
    id: stableId(
      'l1-executed-round',
      hash(log.blockHash, 'block hash'),
      hash(log.transactionHash, 'transaction hash'),
      lineageId,
      round,
      sequencer,
      targetEpoch,
      actionIndex,
      JSON.stringify(data),
    ),
    network: network(selectedNetwork),
    source: 'ethereum_l1',
    kind: 'l1_round',
    sequencer,
    lineageId,
    targetEpoch,
    round,
    provenance: {
      observedAt: toIso(observedAt),
      blockNumber: unsignedString(log.blockNumber, 'block number'),
      blockHash: hash(log.blockHash, 'block hash'),
      transactionHash: hash(log.transactionHash, 'transaction hash'),
      canonical: true,
    },
    data,
  };
}

export function slashObservation({ network: selectedNetwork, log, execution, observedAt }) {
  if (!execution) {
    throw new Error(
      `Slashed log ${log.transactionHash}:${log.logIndex} has no exact RoundExecuted case link`,
    );
  }
  return {
    id: `l1-slash:${hash(log.blockHash, 'block hash')}:${unsignedInteger(log.logIndex, 'log index')}`,
    network: network(selectedNetwork),
    source: 'ethereum_l1',
    kind: 'l1_slash',
    sequencer: address(log.sequencer, 'sequencer'),
    lineageId: execution.lineageId,
    targetEpoch: execution.targetEpoch,
    round: execution.round,
    provenance: {
      observedAt: toIso(observedAt),
      blockNumber: unsignedString(log.blockNumber, 'block number'),
      blockHash: hash(log.blockHash, 'block hash'),
      transactionHash: hash(log.transactionHash, 'transaction hash'),
      ...(log.blockTimestamp === undefined || log.blockTimestamp === null
        ? {}
        : { blockTime: toIso(unsignedInteger(log.blockTimestamp, 'block timestamp')) }),
      canonical: true,
    },
    data: {
      amount: unsignedString(log.amount, 'slash amount'),
      actionIndex: unsignedInteger(log.transactionSlashIndex, 'transaction slash index'),
      round: execution.round,
      rollupAddress: address(log.rollupAddress, 'Rollup'),
      ...slashOutcome(log),
    },
  };
}

// The stake left after the slash block and the ejection threshold then in
// force, when the archive reads succeeded.
export function slashOutcome({ stakeAfter, ejectionThreshold }) {
  return {
    ...(stakeAfter === undefined || stakeAfter === null
      ? {}
      : { stakeAfter: unsignedString(stakeAfter, 'stake after slash') }),
    ...(ejectionThreshold === undefined || ejectionThreshold === null
      ? {}
      : { ejectionThreshold: unsignedString(ejectionThreshold, 'ejection threshold') }),
  };
}

export function stakeStatusObservation({ slash, status }) {
  return {
    ...slash,
    id: stableId('stake-status', slash.id, status),
    kind: 'stake_status',
    data: {
      ejected: true,
      status: Number(status) === 2 ? 'zombie' : 'exiting',
      actualAmount: slash.data.amount,
      round: slash.round,
    },
  };
}

export function nodeOffenseObservation({
  offense,
  status,
  lineage,
  epochDuration,
  network: selectedNetwork,
  observedAt,
}) {
  const targetEpoch = offense.timeUnit === 'slot'
    ? (BigInt(offense.epochOrSlot) / BigInt(epochDuration)).toString()
    : offense.epochOrSlot;
  const expectedRound = (
    BigInt(targetEpoch) / BigInt(lineage.parameters.roundSizeEpochs) +
    BigInt(lineage.parameters.slashOffsetRounds)
  ).toString();
  return {
    id: stableId('node-offense', offense.id, status, observedAt),
    network: network(selectedNetwork),
    source: 'aztec_node',
    kind: 'node_offense',
    sequencer: address(offense.sequencer, 'sequencer'),
    lineageId: lineage.proposerAddress,
    targetEpoch,
    slot: offense.timeUnit === 'slot' ? offense.epochOrSlot : undefined,
    round: expectedRound,
    provenance: {
      observedAt: toIso(observedAt),
      nodeCursor: offense.id,
      canonical: true,
    },
    data: {
      ...offense,
      status,
      expectedRound,
      amount: unsignedString(offense.amount, 'offense amount'),
    },
  };
}

export function sentinelObservation({
  kind,
  network: selectedNetwork,
  lineage,
  sequencer,
  epoch,
  observedAt,
  l1BlockNumber,
  l1BlockHash,
  data,
}) {
  return {
    id: stableId('sentinel', kind, lineage.proposerAddress, sequencer, epoch),
    network: network(selectedNetwork),
    source: 'aztec_sentinel',
    kind,
    sequencer: address(sequencer, 'sequencer'),
    lineageId: lineage.proposerAddress,
    targetEpoch: String(epoch),
    slot: data.slot ?? data.firstMissedSlot ?? undefined,
    provenance: {
      observedAt: toIso(observedAt),
      ...(l1BlockNumber === undefined
        ? {}
        : { blockNumber: unsignedString(l1BlockNumber, 'L1 block') }),
      ...(l1BlockHash
        ? { blockHash: hash(l1BlockHash, 'L1 block hash') }
        : {}),
      canonical: true,
    },
    data,
  };
}

export function normalizeObservation(input) {
  const observation = {
    ...input,
    id: String(input?.id ?? ''),
    network: network(input?.network),
    source: String(input?.source ?? ''),
    kind: String(input?.kind ?? ''),
    sequencer: address(input?.sequencer, 'sequencer'),
    lineageId: address(input?.lineageId, 'lineage'),
    targetEpoch: unsignedString(input?.targetEpoch, 'target epoch'),
    provenance: {
      ...input?.provenance,
      observedAt: toIso(input?.provenance?.observedAt),
      canonical: input?.provenance?.canonical !== false,
    },
    data: input?.data && typeof input.data === 'object' ? input.data : {},
  };
  if (!observation.id) throw new Error('observation id is required');
  if (!['aztec_sentinel', 'aztec_node', 'ethereum_l1'].includes(observation.source)) {
    throw new Error(`invalid observation source: ${observation.source}`);
  }
  return observation;
}

export function normalizeAddressList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('At least one sequencer address is required');
  }
  return [...new Set(values.map((item) => address(item, 'sequencer')))].sort();
}

export function transitionEvent(transition, currentCase) {
  const latestL1 = [...currentCase.observations].reverse().find(
    (item) => item.source === 'ethereum_l1' && item.provenance.canonical,
  );
  return {
    id: transition.id,
    network: currentCase.network,
    source: 'case',
    type: 'case_transition',
    severity: transition.severity,
    title: transition.title,
    body: transition.body,
    targets: [transition.sequencer],
    data: {
      caseId: transition.caseId,
      sequencer: transition.sequencer,
      targetEpoch: currentCase.targetEpoch,
      lineageId: currentCase.lineageId,
      fromStage: transition.fromStage,
      toStage: transition.toStage,
      payloadAddress: currentCase.state.payloadAddress,
      blockNumber: latestL1?.provenance.blockNumber ?? null,
      transactionHash: currentCase.observations.find(
        (item) => item.kind === 'l1_slash',
      )?.provenance.transactionHash ?? null,
    },
    observedAt: transition.observedAt,
  };
}

export function normalizeDutyHistory(history, { sequencer, fromSlot, toSlot }) {
  if (!Array.isArray(history)) throw new Error(`Sentinel history for ${sequencer} is invalid`);
  const seen = new Set();
  return history.map((item) => {
    const slot = unsignedInteger(item?.slot, `duty slot for ${sequencer}`);
    if (slot < fromSlot || slot > toSlot || seen.has(slot)) {
      throw new Error(`Sentinel history for ${sequencer} contains an invalid duty slot`);
    }
    seen.add(slot);
    const status = String(item?.status ?? '');
    if (!DUTY_STATUSES.has(status)) {
      throw new Error(`Sentinel history for ${sequencer} has invalid status ${status}`);
    }
    return { slot, status };
  }).sort((left, right) => left.slot - right.slot);
}

export function summarizeDutyHistory(history) {
  const missedItems = history.filter((item) => MISSED_DUTIES.has(item.status));
  return {
    missed: missedItems.length,
    total: history.length,
    firstMissedSlot: missedItems[0]?.slot ?? null,
    lastMissedSlot: missedItems[missedItems.length - 1]?.slot ?? null,
  };
}

export function hasAdvancingAbsence(evidence) {
  return Boolean(evidence?.slot?.advanced || evidence?.epoch?.advanced);
}

export function canAdvanceOffenseAbsence(offense, evidence) {
  const cursor = evidence?.[offense?.timeUnit];
  if (!cursor?.advanced) return false;
  try {
    return BigInt(cursor.value) >= BigInt(offense.epochOrSlot);
  } catch {
    return false;
  }
}

export function slotTime(protocol, slot) {
  const seconds = BigInt(protocol.genesisTime) +
    BigInt(slot) * BigInt(protocol.slotDurationSeconds);
  const milliseconds = seconds * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return new Date(Number(milliseconds)).toISOString();
}
