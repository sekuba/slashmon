import { describe, expect, it } from 'vitest';
import type { ProtocolSnapshot } from '@shared/protocol/index.ts';
import type { SequencerState } from './sequencerState';
import { penaltyAmounts, stakeOutlook } from './stakeOutlook';

const AZTEC = 10n ** 18n;

describe('stakeOutlook', () => {
    it('counts the slashes a validator can take before ejection', () => {
        const outlook = stakeOutlook(state('validating', 196_000n * AZTEC), protocol());

        expect(outlook).toMatchObject({ tone: 'warning', status: 'Validating', stake: 196_000n * AZTEC });
        expect(outlook.detail).toBe(
            '4,000 AZTEC below the 200,000 AZTEC starting stake. ' +
            '6,000 AZTEC above the 190,000 AZTEC ejection threshold. ' +
            'It can take 3 more 2,000 AZTEC slashes or 1 more 5,000 AZTEC slash and keep validating; ' +
            'one more after that ejects it.',
        );
    });

    it('keeps a stake exactly at the threshold, and ejects on the next slash', () => {
        const outlook = stakeOutlook(state('validating', 191_000n * AZTEC), protocol());

        expect(outlook.tone).toBe('critical');
        expect(outlook.detail).toContain('The next slash of any size ejects it.');
        const oneLeft = stakeOutlook(state('validating', 192_000n * AZTEC), protocol());
        expect(oneLeft.tone).toBe('critical');
        expect(oneLeft.detail).toContain(
            'It can take 1 more 2,000 AZTEC slash and keep validating; ' +
            'a 5,000 AZTEC slash would eject it now.',
        );
        expect(stakeOutlook(state('validating', 190_000n * AZTEC), protocol()).detail)
            .toContain('0 AZTEC above the 190,000 AZTEC ejection threshold. The next slash of any size ejects it.');
    });

    it('explains a zombie exit and when it can be claimed', () => {
        const outlook = stakeOutlook({
            ...state('zombie', 0n),
            exit: { amount: 188_000n * AZTEC, exitableAt: 2_000n, hasRecipient: false },
        }, protocol(), 3_000_000);

        expect(outlook).toMatchObject({
            tone: 'critical',
            status: 'Ejected (zombie)',
            stake: 188_000n * AZTEC,
        });
        expect(outlook.detail).toContain('188,000 AZTEC waits in an exit');
        expect(outlook.detail).toContain('the withdrawer must start the withdrawal and can claim it now.');
        expect(outlook.detail).not.toContain('until then');
        expect(stakeOutlook({
            ...state('zombie', 0n),
            exit: { amount: 188_000n * AZTEC, exitableAt: 2_000n, hasRecipient: false },
        }, protocol(), 1_000_000).detail).toContain('Slashes for older epochs can still reduce it until then.');
    });

    it('does not guess without staking parameters', () => {
        const outlook = stakeOutlook(state('validating', 196_000n * AZTEC), {
            ...protocol(),
            staking: null,
        });
        expect(outlook.detail).toBe('The ejection threshold is not available from this source.');
    });

    it('lists distinct penalty sizes smallest first', () => {
        expect(penaltyAmounts(protocol())).toEqual([2_000n * AZTEC, 5_000n * AZTEC]);
        expect(penaltyAmounts(null)).toEqual([]);
    });
});

function state(status: SequencerState['status'], effectiveBalance: bigint): SequencerState {
    return {
        sequencer: '0x1111111111111111111111111111111111111111',
        status,
        effectiveBalance,
        exit: null,
        blockNumber: 1n,
        blockHash: `0x${'11'.repeat(32)}`,
    };
}

function protocol(): ProtocolSnapshot {
    return {
        network: 'mainnet',
        chainId: 1,
        observedAt: '2026-09-20T00:00:00.000Z',
        blockNumber: '1',
        blockHash: `0x${'11'.repeat(32)}`,
        registryAddress: '0x3333333333333333333333333333333333333333',
        rollupAddress: '0x4444444444444444444444444444444444444444',
        genesisTime: '0',
        currentSlot: '0',
        currentEpoch: '0',
        slotDurationSeconds: 72,
        epochDurationSlots: 32,
        inactivity: null,
        staking: {
            activationThreshold: (200_000n * AZTEC).toString(),
            localEjectionThreshold: (190_000n * AZTEC).toString(),
            exitDelaySeconds: 345_600,
        },
        lineages: [{
            role: 'active',
            rollupAddress: '0x4444444444444444444444444444444444444444',
            slasherAddress: '0x5555555555555555555555555555555555555555',
            proposerAddress: '0x2222222222222222222222222222222222222222',
            currentRound: '1',
            isSlashingEnabled: true,
            disabledUntil: null,
            parameters: {
                quorum: 65,
                roundSizeSlots: 128,
                roundSizeEpochs: 4,
                executionDelayRounds: 28,
                lifetimeRounds: 34,
                slashOffsetRounds: 2,
                committeeSize: 48,
                slashAmounts: [2_000n, 5_000n, 5_000n].map((value) => (value * AZTEC).toString()),
            },
        }],
    };
}
