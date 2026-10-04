import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import { projectMonitorCases } from './monitorCases';
import type {
    ConfirmedExecution,
    ConfirmedSlash,
    CurrentChainState,
    DetectedSlashing,
    ExecutionHistoryScan,
    ResolvedMonitorConfig,
} from '@/types/slashing';

const SEQUENCER = '0x1111111111111111111111111111111111111111' as Address;
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const;
const TX_HASH = `0x${'cd'.repeat(32)}` as const;

const config: ResolvedMonitorConfig = {
    l1RpcUrl: 'https://rpc.example',
    chainId: 1,
    registryAddress: '0x2222222222222222222222222222222222222222' as Address,
    resolvedAtBlockNumber: 90n,
    resolvedAtTimestamp: 1_700_000_000n,
    rollupAddress: '0x3333333333333333333333333333333333333333' as Address,
    slasherAddress: '0x4444444444444444444444444444444444444444' as Address,
    slashingProposerAddress: '0x5555555555555555555555555555555555555555' as Address,
    rollupVersion: 1n,
    pendingSlasherAddress: zeroAddress,
    pendingSlashingProposerAddress: zeroAddress,
    pendingSlasherReadyAt: 0n,
    legacySlasherAddress: zeroAddress,
    legacySlashingProposerAddress: zeroAddress,
    legacySlasherAuthorizedUntil: 0n,
    slashingRoundSize: 128,
    slashingRoundSizeInEpochs: 4,
    executionDelayInRounds: 28,
    lifetimeInRounds: 34,
    slashOffsetInRounds: 2,
    quorum: 65,
    committeeSize: 48,
    slotDuration: 72,
    epochDuration: 32,
    l1GenesisTime: 1_700_000_000n,
    slashAmounts: [2_000n, 5_000n, 5_000n],
    staking: {
        activationThreshold: 200_000n,
        localEjectionThreshold: 190_000n,
        exitDelay: 345_600n,
    },
};

const state: CurrentChainState = {
    l1BlockNumber: 100n,
    l1BlockHash: BLOCK_HASH,
    l1Timestamp: 1_700_100_000n,
    currentRound: 11n,
    currentSlot: 1_408n,
    currentEpoch: 44n,
    isSlashingEnabled: true,
    slashingDisabledUntil: 0n,
    slashingDisableDuration: 0n,
    pauseStartedAtSlot: null,
    pauseEndsAtSlot: null,
};

const idleScan: ExecutionHistoryScan = {
    status: 'idle',
    targetFromBlock: null,
    headBlock: null,
    oldestScannedBlock: null,
    scannedBlocks: 0n,
    totalBlocks: 0n,
    chunkSize: 1_024n,
    lastError: null,
};

function detectedRound(overrides: Partial<DetectedSlashing> = {}): DetectedSlashing {
    return {
        round: 10n,
        status: 'quorum-reached',
        ballotCount: 70n,
        isExecuted: false,
        isVetoed: false,
        verificationStatus: 'verified',
        targetDetails: [{
            sequencer: SEQUENCER,
            epochIndex: 0,
            committeeIndex: 3,
            targetEpoch: 32n,
            voteCount: 66,
            support: 66,
            maxSlashUnits: 1,
            unitVoteCounts: [66, 0, 0],
            slashUnits: 1,
            amount: 2_000_000_000_000_000_000_000n,
            actionIndex: 0,
        }],
        ...overrides,
    };
}

function project(input: {
    slashings?: DetectedSlashing[];
    confirmedExecutions?: ConfirmedExecution[];
    confirmedSlashes?: ConfirmedSlash[];
    executionScan?: ExecutionHistoryScan;
} = {}) {
    return projectMonitorCases({
        network: 'mainnet',
        config,
        state,
        slashings: input.slashings ?? [],
        confirmedExecutions: input.confirmedExecutions ?? [],
        confirmedSlashes: input.confirmedSlashes ?? [],
        executionScan: input.executionScan ?? idleScan,
    });
}

describe('projectMonitorCases', () => {
    it('projects the chain state into one lineage-pinned protocol snapshot', () => {
        const { protocol } = project();
        expect(protocol.blockNumber).toBe('100');
        expect(protocol.blockHash).toBe(BLOCK_HASH);
        expect(protocol.lineages).toHaveLength(1);
        expect(protocol.lineages[0].proposerAddress)
            .toBe(config.slashingProposerAddress.toLowerCase());
        expect(protocol.lineages[0].parameters).toEqual({
            quorum: 65,
            roundSizeSlots: 128,
            roundSizeEpochs: 4,
            executionDelayRounds: 28,
            lifetimeRounds: 34,
            slashOffsetRounds: 2,
            committeeSize: 48,
            slashAmounts: ['2000', '5000', '5000'],
        });
        expect(protocol.staking).toEqual({
            activationThreshold: '200000',
            localEjectionThreshold: '190000',
            exitDelaySeconds: 345_600,
        });
    });

    it('projects an open candidate round with derived lifecycle slots', () => {
        const { cases } = project({ slashings: [detectedRound()] });
        expect(cases).toHaveLength(1);
        expect(cases[0].sequencer).toBe(SEQUENCER);
        expect(cases[0].targetEpoch).toBe('32');
        // currentRound (11) > round (10), so the tally is stable: 'delayed'.
        expect(cases[0].state.stage).toBe('delayed');
        expect(cases[0].state.requestedAmount).toBe('2000000000000000000000');
        const data = cases[0].observations[0].data;
        expect(data.executableSlot).toBe(((10n + 1n + 28n) * 128n).toString());
        expect(data.expirySlot).toBe(((10n + 1n + 34n) * 128n).toString());
    });

    it('reports the receipt-scan state for an executed round without a receipt', () => {
        const executed = detectedRound({ status: 'executed', isExecuted: true });
        const scanning = project({
            slashings: [executed],
            executionScan: { ...idleScan, status: 'scanning' },
        });
        expect(scanning.cases[0].state.stage).toBe('executed');
        expect(scanning.cases[0].observations[0].data.executionReceiptStatus)
            .toBe('scanning');

        const complete = project({
            slashings: [executed],
            executionScan: { ...idleScan, status: 'complete' },
        });
        expect(complete.cases[0].observations[0].data.executionReceiptStatus)
            .toBe('unavailable');
    });

    it('confirms an actual slash and an ejection through the execution receipt', () => {
        const executed = detectedRound({ status: 'executed', isExecuted: true });
        const execution: ConfirmedExecution = {
            round: 10n,
            slashCount: 1n,
            transactionHash: TX_HASH,
            blockNumber: 99n,
            blockHash: BLOCK_HASH,
        };
        const slash: ConfirmedSlash = {
            sequencer: SEQUENCER,
            targetEpoch: 32n,
            round: 10n,
            amount: 2_000_000_000_000_000_000_000n,
            actionIndex: 0,
            transactionHash: TX_HASH,
            blockNumber: 99n,
            blockHash: BLOCK_HASH,
            ejected: false,
            attesterStatus: 1,
            blockTimestamp: 1_700_000_500n,
            stakeAfter: 198_000n,
        };

        const slashed = project({
            slashings: [executed],
            confirmedExecutions: [execution],
            confirmedSlashes: [slash],
        });
        expect(slashed.cases[0].state.stage).toBe('stake_removed');
        expect(slashed.cases[0].state.actualAmount).toBe('2000000000000000000000');
        const slashObservation = slashed.cases[0].observations.find((item) =>
            item.kind === 'l1_slash');
        expect(slashObservation?.provenance.blockTime)
            .toBe(new Date(1_700_000_500_000).toISOString());
        expect(slashObservation?.data).toMatchObject({
            stakeAfter: '198000',
            ejectionThreshold: '190000',
        });

        const ejected = project({
            slashings: [executed],
            confirmedExecutions: [execution],
            confirmedSlashes: [{ ...slash, ejected: true, attesterStatus: 2 }],
        });
        expect(ejected.cases[0].state.stage).toBe('ejected');
    });
});
