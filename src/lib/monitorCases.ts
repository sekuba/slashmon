import {
    projectCases,
    type Observation,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import {
    calculateExecutableSlot,
    calculateExpirySlot,
    isRoundProtectedByPause,
} from './slashingLifecycle';
import type {
    ConfirmedExecution,
    ConfirmedSlash,
    CurrentChainState,
    DetectedSlashing,
    ExecutionHistoryScan,
    ResolvedMonitorConfig,
} from '@/types/slashing';
import type { MonitorNetwork } from '@/types/backendApi';

export function projectMonitorCases({
    network,
    config,
    state,
    slashings,
    confirmedExecutions,
    confirmedSlashes,
    executionScan,
}: {
    network: MonitorNetwork;
    config: ResolvedMonitorConfig;
    state: CurrentChainState;
    slashings: DetectedSlashing[];
    confirmedExecutions: ConfirmedExecution[];
    confirmedSlashes: ConfirmedSlash[];
    executionScan: ExecutionHistoryScan;
}): { protocol: ProtocolSnapshot; cases: SlashingCase[] } {
    const observedAt = new Date(Number(state.l1Timestamp) * 1_000).toISOString();
    const protocol: ProtocolSnapshot = {
        network,
        chainId: config.chainId,
        observedAt,
        blockNumber: state.l1BlockNumber.toString(),
        blockHash: state.l1BlockHash,
        registryAddress: config.registryAddress.toLowerCase(),
        rollupAddress: config.rollupAddress.toLowerCase(),
        genesisTime: config.l1GenesisTime.toString(),
        currentSlot: state.currentSlot.toString(),
        currentEpoch: state.currentEpoch.toString(),
        slotDurationSeconds: config.slotDuration,
        epochDurationSlots: config.epochDuration,
        inactivity: null,
        staking: config.staking && {
            activationThreshold: config.staking.activationThreshold.toString(),
            localEjectionThreshold: config.staking.localEjectionThreshold.toString(),
            exitDelaySeconds: Number(config.staking.exitDelay),
        },
        lineages: [{
            role: 'active',
            rollupAddress: config.rollupAddress.toLowerCase(),
            slasherAddress: config.slasherAddress.toLowerCase(),
            proposerAddress: config.slashingProposerAddress.toLowerCase(),
            currentRound: state.currentRound.toString(),
            isSlashingEnabled: state.isSlashingEnabled,
            disabledUntil: state.slashingDisabledUntil === 0n
                ? null
                : state.slashingDisabledUntil.toString(),
            parameters: {
                quorum: config.quorum,
                roundSizeSlots: config.slashingRoundSize,
                roundSizeEpochs: config.slashingRoundSizeInEpochs,
                executionDelayRounds: config.executionDelayInRounds,
                lifetimeRounds: config.lifetimeInRounds,
                slashOffsetRounds: config.slashOffsetInRounds,
                committeeSize: config.committeeSize,
                slashAmounts: config.slashAmounts?.map(String) ?? null,
            },
        }],
    };
    const executionByRound = new Map(
        confirmedExecutions.map((execution) => [execution.round, execution]),
    );
    const roundObservations: Observation[] = slashings.flatMap((round) => {
        const roundEndSlot = (round.round + 1n) * BigInt(config.slashingRoundSize);
        const executableSlot = round.slotWhenExecutable ??
            calculateExecutableSlot(round.round, config);
        const expirySlot = round.slotWhenExpires ??
            calculateExpirySlot(round.round, config);
        const isProtected = isRoundProtectedByPause(
            round.round,
            config,
            state.isSlashingEnabled,
            state.pauseStartedAtSlot,
            state.pauseEndsAtSlot,
        );
        return (round.targetDetails ?? []).map((target) => {
            return {
                id: [
                    'monitor',
                    state.l1BlockHash,
                    round.round,
                    target.targetEpoch,
                    target.sequencer.toLowerCase(),
                ].join(':'),
                network,
                source: 'ethereum_l1',
                kind: 'l1_round',
                sequencer: target.sequencer.toLowerCase(),
                lineageId: config.slashingProposerAddress.toLowerCase(),
                targetEpoch: target.targetEpoch.toString(),
                round: round.round.toString(),
                provenance: {
                    observedAt,
                    blockNumber: state.l1BlockNumber.toString(),
                    blockHash: state.l1BlockHash,
                    canonical: true,
                },
                data: {
                    round: round.round.toString(),
                    status: round.status,
                    support: target.support,
                    quorum: config.quorum,
                    amount: target.amount?.toString() ?? null,
                    maxSlashUnits: target.maxSlashUnits,
                    unitVoteCounts: target.unitVoteCounts,
                    escaped: Boolean(target.escaped),
                    payloadAddress: round.payloadAddress?.toLowerCase() ?? null,
                    isVetoed: round.isVetoed,
                    isExecuted: round.isExecuted,
                    executionReceiptStatus: round.isExecuted
                        ? executionByRound.has(round.round)
                            ? 'inspected'
                            : executionScan.status === 'complete'
                                ? 'unavailable'
                                : executionScan.status === 'paused'
                                    ? 'paused'
                                    : 'scanning'
                        : null,
                    stable: state.currentRound > round.round,
                    isExecutionPaused: !state.isSlashingEnabled && !round.isExecuted,
                    isProtected,
                    roundEndSlot: roundEndSlot.toString(),
                    executableSlot: executableSlot.toString(),
                    expirySlot: expirySlot.toString(),
                    roundEndAt: slotAt(protocol, roundEndSlot),
                    executableAt: slotAt(protocol, executableSlot),
                    expiryAt: slotAt(protocol, expirySlot),
                },
            } satisfies Observation;
        });
    });
    const executionObservations: Observation[] = confirmedExecutions.flatMap(
        (execution) => {
            const round = slashings.find((candidate) =>
                candidate.round === execution.round);
            if (!round) return [];
            return (round.targetDetails ?? [])
                .filter((target) =>
                    target.actionIndex !== undefined &&
                    target.amount !== undefined)
                .map((target) => ({
                    id: [
                        'monitor-execution',
                        execution.blockHash,
                        execution.transactionHash,
                        execution.round,
                        target.actionIndex,
                    ].join(':'),
                    network,
                    source: 'ethereum_l1',
                    kind: 'l1_execution',
                    sequencer: target.sequencer.toLowerCase(),
                    lineageId: config.slashingProposerAddress.toLowerCase(),
                    targetEpoch: target.targetEpoch.toString(),
                    round: execution.round.toString(),
                    provenance: {
                        observedAt,
                        blockNumber: execution.blockNumber.toString(),
                        blockHash: execution.blockHash,
                        transactionHash: execution.transactionHash,
                        canonical: true,
                    },
                    data: {
                        round: execution.round.toString(),
                        slashCount: execution.slashCount.toString(),
                        actionIndex: target.actionIndex,
                    },
                } satisfies Observation));
        },
    );
    const slashObservations: Observation[] = confirmedSlashes.flatMap((slash) => {
        const base: Observation = {
            id: [
                'monitor-slash',
                slash.blockHash,
                slash.transactionHash,
                slash.actionIndex,
            ].join(':'),
            network,
            source: 'ethereum_l1',
            kind: 'l1_slash',
            sequencer: slash.sequencer.toLowerCase(),
            lineageId: config.slashingProposerAddress.toLowerCase(),
            targetEpoch: slash.targetEpoch.toString(),
            round: slash.round.toString(),
            provenance: {
                observedAt,
                blockNumber: slash.blockNumber.toString(),
                blockHash: slash.blockHash,
                transactionHash: slash.transactionHash,
                ...(slash.blockTimestamp === null
                    ? {}
                    : { blockTime: new Date(Number(slash.blockTimestamp) * 1_000).toISOString() }),
                canonical: true,
            },
            data: {
                round: slash.round.toString(),
                amount: slash.amount.toString(),
                actionIndex: slash.actionIndex,
                ...(slash.stakeAfter === null
                    ? {}
                    : {
                        stakeAfter: slash.stakeAfter.toString(),
                        // The Monitor sees only recent slashes, under the current rules.
                        ...(config.staking
                            ? { ejectionThreshold: config.staking.localEjectionThreshold.toString() }
                            : {}),
                    }),
            },
        };
        if (!slash.ejected) return [base];
        return [base, {
            ...base,
            id: `${base.id}:status:${slash.attesterStatus}`,
            kind: 'stake_status',
            data: {
                ejected: true,
                status: slash.attesterStatus === 2 ? 'zombie' : 'exiting',
                actualAmount: slash.amount.toString(),
                round: slash.round.toString(),
            },
        }];
    });
    return {
        protocol,
        cases: projectCases([
            ...roundObservations,
            ...executionObservations,
            ...slashObservations,
        ], protocol),
    };
}

function slotAt(protocol: ProtocolSnapshot, slot: bigint): string {
    const seconds = BigInt(protocol.genesisTime) +
        slot * BigInt(protocol.slotDurationSeconds);
    return new Date(Number(seconds) * 1_000).toISOString();
}
