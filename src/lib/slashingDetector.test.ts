import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address } from 'viem';
import type { ResolvedMonitorConfig, RoundInfo, SlashAction } from '@/types/slashing';
import type { L1Monitor } from './l1Monitor';
import type { MulticallResult } from './multicall';
import { SlashingDetector } from './slashingDetector';

const validator = '0x00000000000000000000000000000000000000aa' as Address;
const payload = '0x00000000000000000000000000000000000000bb' as Address;

describe('SlashingDetector quorum verification', () => {
    it('does not treat total ballot count as validator quorum', async () => {
        const fake = createFakeMonitor({ ballotCount: 65n, actions: [], votedEpochs: [0] });
        const result = await new SlashingDetector(config, fake.monitor).detectExecutableRounds(100n, 12_800n);
        const current = result.detectedSlashings.find((round) => round.round === 100n);

        expect(current).toMatchObject({ status: 'below-quorum', ballotCount: 65n });
        expect(current?.slashActions).toBeUndefined();
        expect(fake.calls.committees).toBe(1);
        expect(fake.calls.tallies).toBe(1);
        expect(fake.calls.payloads).toBe(0);
    });

    it('uses nonempty tally output as the evidence that a target reached quorum', async () => {
        const actions: SlashAction[] = [{ validator, slashAmount: 2_000n }];
        const fake = createFakeMonitor({ ballotCount: 65n, actions, votedEpochs: [0] });
        const result = await new SlashingDetector(config, fake.monitor).detectExecutableRounds(100n, 12_800n);
        const current = result.detectedSlashings.find((round) => round.round === 100n);

        expect(current).toMatchObject({
            status: 'quorum-reached',
            verificationStatus: 'verified',
            affectedValidatorCount: 1,
            totalSlashAmount: 2_000n,
            payloadAddress: payload,
        });
        expect(fake.calls.payloads).toBe(1);
    });

    it('shows exact pre-quorum targets without constructing a payload', async () => {
        const fake = createFakeMonitor({ ballotCount: 64n, actions: [], votedEpochs: [0] });
        const result = await new SlashingDetector(config, fake.monitor).detectExecutableRounds(100n, 12_800n);
        const current = result.detectedSlashings.find((round) => round.round === 100n);

        expect(current?.status).toBe('below-quorum');
        expect(current?.targetDetails).toEqual([
            expect.objectContaining({
                sequencer: validator,
                targetEpoch: 392n,
                voteCount: 64,
                support: 64,
            }),
        ]);
        expect(fake.calls.committees).toBe(1);
        expect(fake.calls.tallies).toBe(0);
        expect(fake.calls.payloads).toBe(0);
    });

    it('marks tally failures partial without asserting quorum', async () => {
        const fake = createFakeMonitor({ ballotCount: 65n, tallyFailure: true, votedEpochs: [0] });
        const result = await new SlashingDetector(config, fake.monitor).detectExecutableRounds(100n, 12_800n);
        const current = result.detectedSlashings.find((round) => round.round === 100n);

        expect(current).toMatchObject({
            status: 'below-quorum',
            verificationStatus: 'partial',
        });
        expect(result.issues).toHaveLength(1);
        expect(fake.calls.payloads).toBe(0);
    });

    it('counts validator addresses uniquely while summing all actions', async () => {
        const actions: SlashAction[] = [
            { validator, slashAmount: 2_000n },
            { validator: validator.toUpperCase() as Address, slashAmount: 5_000n },
        ];
        const fake = createFakeMonitor({ ballotCount: 65n, actions, votedEpochs: [0, 1] });
        const result = await new SlashingDetector(config, fake.monitor).detectExecutableRounds(100n, 12_800n);
        const current = result.detectedSlashings.find((round) => round.round === 100n);

        expect(current?.affectedValidatorCount).toBe(1);
        expect(current?.totalSlashAmount).toBe(7_000n);
    });

    it('keeps an escape-hatch target visible beside a different executable action', async () => {
        const fake = createFakeMonitor({
            ballotCount: 65n,
            actions: [{ validator, slashAmount: 2_000n }],
            votedEpochs: [0, 1],
            escapedEpochs: [1],
        });
        const result = await new SlashingDetector(
            config,
            fake.monitor,
        ).detectExecutableRounds(100n, 12_800n);
        const current = result.detectedSlashings.find((round) => round.round === 100n);

        expect(current?.targetDetails).toHaveLength(2);
        expect(current?.targetDetails?.[0]).toMatchObject({
            targetEpoch: 392n,
            amount: 2_000n,
            actionIndex: 0,
        });
        expect(current?.targetDetails?.[1]).toMatchObject({
            targetEpoch: 393n,
            amount: undefined,
            escaped: true,
        });
    });
});

const config: ResolvedMonitorConfig = {
    l1RpcUrl: 'http://localhost:8545',
    chainId: 1,
    registryAddress: zeroAddress,
    resolvedAtBlockNumber: 1n,
    resolvedAtTimestamp: 1n,
    rollupAddress: zeroAddress,
    slasherAddress: zeroAddress,
    slashingProposerAddress: zeroAddress,
    rollupVersion: 5n,
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
      slashAmounts: null,
      staking: null,
};

function createFakeMonitor(options: {
    ballotCount: bigint;
    actions?: SlashAction[];
    tallyFailure?: boolean;
    votedEpochs?: number[];
    escapedEpochs?: number[];
}) {
    const calls = { committees: 0, tallies: 0, payloads: 0 };
    const monitor = {
        getRounds: async (rounds: bigint[]) => new Map<bigint, MulticallResult<RoundInfo>>(
            rounds.map((round) => [round, {
                success: true,
                data: {
                    round,
                    isExecuted: false,
                    ballotCount: round === 100n ? options.ballotCount : 0n,
                },
            }])
        ),
        batchGetSlashTargetCommittees: async (rounds: bigint[]) => {
            calls.committees += 1;
            return rounds.map(() => ({ success: true, data: [[validator], [validator], [validator], [validator]] }));
        },
        getVotes: async () => Array.from(
            { length: Number(options.ballotCount) },
            () => encodedVote(options.votedEpochs ?? []),
        ),
        getEscapeHatchFlags: async (epochs: bigint[]) =>
            epochs.map((_, index) => options.escapedEpochs?.includes(index) ?? false),
        batchGetTally: async (rounds: Array<{ round: bigint }>) => {
            calls.tallies += 1;
            return rounds.map(() => options.tallyFailure
                ? { success: false, error: new Error('tally unavailable') }
                : { success: true, data: options.actions ?? [] });
        },
        batchGetPayloadAddressesAndVetoStatus: async (rounds: Array<{ round: bigint }>) => {
            calls.payloads += 1;
            return rounds.map(() => ({ success: true, data: { payloadAddress: payload, isVetoed: false } }));
        },
    } as unknown as L1Monitor;

    return { monitor, calls };
}

function encodedVote(epochIndexes: number[]): `0x${string}` {
    const bytes = new Uint8Array(48);
    for (const epochIndex of epochIndexes) {
        const validatorIndex = epochIndex * config.committeeSize;
        bytes[Math.floor(validatorIndex / 4)] |= 1 << ((validatorIndex % 4) * 2);
    }
    return `0x${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
