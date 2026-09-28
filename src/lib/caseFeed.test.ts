import { describe, expect, it } from 'vitest';
import {
    selectCaseFeed,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import { currentRoundProgress } from '@/components/CaseFeed';
import { groupCasesByPayload } from './caseFeed';

describe('selectCaseFeed', () => {
    it('keeps every active case and only the latest execution outcomes', () => {
        const executedWithoutDeduction = item(
            'executed-no-deduction',
            'resolved',
            false,
            '2026-07-08T00:00:00.000Z',
        );
        executedWithoutDeduction.observations = [{
            id: 'execution',
            network: 'mainnet',
            source: 'ethereum_l1',
            kind: 'l1_round',
            sequencer: executedWithoutDeduction.sequencer,
            lineageId: executedWithoutDeduction.lineageId,
            targetEpoch: executedWithoutDeduction.targetEpoch,
            provenance: {
                observedAt: '2026-07-08T00:00:00.000Z',
                canonical: true,
            },
            data: { isExecuted: true, status: 'executed' },
        }];
        const cases = [
            item('active-old', 'candidate', true, '2026-07-01T00:00:00.000Z'),
            item('expired', 'expired', false, '2026-07-10T00:00:00.000Z'),
            item('executed-old', 'executed', false, '2026-07-02T00:00:00.000Z'),
            item('slashed-new', 'stake_removed', false, '2026-07-09T00:00:00.000Z'),
            item('resolved', 'resolved', false, '2026-07-11T00:00:00.000Z'),
            item('precursor-new', 'precursor', true, '2026-07-12T00:00:00.000Z'),
            executedWithoutDeduction,
        ];

        const result = selectCaseFeed(cases, 2);

        expect(result.active.map((entry) => entry.id)).toEqual([
            'precursor-new',
            'active-old',
        ]);
        expect(result.recentlyExecuted.map((entry) => entry.id)).toEqual([
            'slashed-new',
            'executed-no-deduction',
        ]);
    });

    it('groups exact payload cases and keeps pre-payload evidence separate', () => {
        const olderPayload = item('older', 'candidate', true, '2026-07-13T00:00:00.000Z');
        const first = item('first', 'candidate', true, '2026-07-12T00:00:00.000Z');
        const second = item('second', 'candidate', true, '2026-07-12T00:00:00.000Z');
        const precursor = item('precursor', 'precursor', true, '2026-07-12T00:00:00.000Z');
        olderPayload.state.payloadAddress = '0x4444444444444444444444444444444444444444';
        olderPayload.state.round = '11';
        first.state.payloadAddress = '0x3333333333333333333333333333333333333333';
        first.state.round = '12';
        second.state.payloadAddress = '0x3333333333333333333333333333333333333333';
        second.state.round = '12';

        const groups = groupCasesByPayload([olderPayload, first, second, precursor]);

        expect(groups).toHaveLength(3);
        expect(groups[0]).toMatchObject({
            id: 'payload:0x3333333333333333333333333333333333333333',
            payloadAddress: '0x3333333333333333333333333333333333333333',
            round: '12',
        });
        expect(groups[0].cases.map((entry) => entry.id)).toEqual(['first', 'second']);
        expect(groups[1]).toMatchObject({
            payloadAddress: '0x4444444444444444444444444444444444444444',
            round: '11',
        });
        expect(groups[2].cases.map((entry) => entry.id)).toEqual(['precursor']);
    });

    it('reports progress through the current epoch of the live round', () => {
        expect(currentRoundProgress(protocol())).toEqual({
            round: '12',
            epoch: '25',
            epochPosition: 2,
            epochsPerRound: 4,
            slotPosition: 5,
            slotsPerEpoch: 8,
            percentage: 62.5,
        });
    });
});

function item(
    id: string,
    stage: SlashingCase['state']['stage'],
    active: boolean,
    lastObservedAt: string,
): SlashingCase {
    return {
        id,
        network: 'mainnet',
        sequencer: '0x1111111111111111111111111111111111111111',
        lineageId: '0x2222222222222222222222222222222222222222',
        targetEpoch: '1',
        firstObservedAt: lastObservedAt,
        lastObservedAt,
        observations: [],
        state: {
            stage,
            active,
            urgency: 'info',
            headline: id,
            explanation: id,
            reason: {
                label: 'Reason unknown on L1',
                provenance: 'unknown_on_l1',
                evidenceIds: [],
            },
            nextTransition: null,
            requestedAmount: null,
            actualAmount: null,
            payloadAddress: null,
            round: null,
        },
    };
}

function protocol(): ProtocolSnapshot {
    return {
        network: 'mainnet',
        chainId: 1,
        observedAt: '2026-07-29T00:00:00.000Z',
        blockNumber: '1',
        blockHash: `0x${'11'.repeat(32)}`,
        registryAddress: '0x1111111111111111111111111111111111111111',
        rollupAddress: '0x2222222222222222222222222222222222222222',
        genesisTime: '0',
        currentSlot: '204',
        currentEpoch: '25',
        slotDurationSeconds: 60,
        epochDurationSlots: 8,
        inactivity: null,
        lineages: [{
            role: 'active',
            rollupAddress: '0x2222222222222222222222222222222222222222',
            slasherAddress: '0x3333333333333333333333333333333333333333',
            proposerAddress: '0x4444444444444444444444444444444444444444',
            currentRound: '12',
            isSlashingEnabled: true,
            disabledUntil: null,
            parameters: {
                quorum: 7,
                roundSizeSlots: 32,
                roundSizeEpochs: 4,
                executionDelayRounds: 2,
                lifetimeRounds: 4,
                slashOffsetRounds: 3,
                committeeSize: 8,
            },
        }],
    };
}
