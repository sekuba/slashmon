import { describe, expect, it } from 'vitest';
import { projectCases } from './cases.ts';
import {
    historyOutcomeLabel,
    historySentences,
    historyTitle,
    sequencerHistory,
} from './history.ts';
import type { Observation, ProtocolSnapshot } from './types.ts';

const sequencer = '0x1111111111111111111111111111111111111111';
const lineageId = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;
const SMALL = '2000000000000000000000';

describe('sequencer history', () => {
    it('tells an inactivity streak and its slashes in epoch order', () => {
        const entries = sequencerHistory(projectCases([
            ...slashed('16', '6', 3, 117),
            ...slashed('12', '5', 2, 114),
            inactive('8', 1),
            miss('40', { status: 'attestation-missed', missed: 1, total: 32 }),
        ], protocol('20')), protocol('20'));

        expect(entries.map((entry) => entry.item.targetEpoch)).toEqual(['8', '12', '16', '40']);
        expect(entries.map(historyOutcomeLabel)).toEqual([
            'No slash',
            'Slash #1 · −2,000 AZTEC',
            'Slash #2 · −2,000 AZTEC',
            'No slash',
        ]);
        expect(entries.map(historyTitle)).toEqual([
            'Inactive epoch',
            'Inactivity offense',
            'Inactivity offense',
            'Missed duty',
        ]);
        expect(historySentences(entries[0], protocol('20'))).toEqual([
            'Missed all 32 duties: its 1st inactive epoch in a row; an offense needs 2, so none yet.',
            'No L1 votes targeted it before voting round 4 closed.',
        ]);
        expect(historySentences(entries[1], protocol('20'))).toEqual([
            'Missed all 32 duties: its 2nd inactive epoch in a row (an offense needs 2).',
            'Offense recorded by this node: Inactivity (2,000 AZTEC penalty).',
            'L1 voting round 5: 114 votes (quorum 65) for a 2,000 AZTEC slash.',
            '2,000 AZTEC was removed from stake.',
        ]);
        expect(entries[1].slashTransactionHash).toBe(TX);
        expect(entries[1].vote?.executableAt).toBe('2026-09-12T07:47:11.000Z');
        expect(historySentences(entries[3], protocol('20'))).toEqual([
            'Missed 1 of 32 duties (first: missed an attestation). Not an inactive epoch (under 70% of duties missed).',
            'No L1 votes targeted it before voting round 12 closed.',
        ]);
    });

    it('dates a slash by its block and says what it left', () => {
        const [entry] = sequencerHistory(projectCases(slashed('12', '5', 2, 114).map((item) =>
            item.kind === 'l1_slash'
                ? {
                    ...item,
                    provenance: { ...item.provenance, blockTime: '2026-09-12T07:47:23.000Z' },
                    data: { ...item.data, stakeAfter: '198000000000000000000000' },
                }
                : item), protocol('20')), protocol('20'));

        expect(entry.slashedAt).toBe('2026-09-12T07:47:23.000Z');
        expect(historySentences(entry, protocol('20')))
            .toContain('2,000 AZTEC was removed from stake, leaving 198,000 AZTEC.');
    });

    it('tells a node clearing an offense apart from its routine expiry', () => {
        // Round 5 of this clock closes at genesis + 6 × 128 slots × 72 s.
        const clock = { ...protocol('6'), genesisTime: '1788000000' };
        const closesAt = (1_788_000_000 + 6 * 128 * 72) * 1_000;
        const removedAt = (milliseconds: number) => sequencerHistory(projectCases([
            {
                ...observation('offense', 'node_offense', '12', {
                    id: 'offense',
                    status: 'active',
                    offenseTypeName: 'inactivity',
                    amount: SMALL,
                    expectedRound: '5',
                }, 'aztec_node'),
                provenance: { observedAt: new Date(closesAt - 3_600_000).toISOString(), canonical: true },
            },
            {
                ...observation('withdrawn', 'node_offense', '12', {
                    id: 'offense',
                    status: 'withdrawn',
                    offenseTypeName: 'inactivity',
                    amount: SMALL,
                    expectedRound: '5',
                }, 'aztec_node'),
                provenance: { observedAt: new Date(milliseconds).toISOString(), canonical: true },
            },
        ], clock), clock)[0];

        const cleared = removedAt(closesAt - 60_000);
        expect(cleared.offense?.cleared).toBe(true);
        expect(historySentences(cleared, clock)).toContain(
            'The node cleared it before its voting round closed, so it did not vote on it.',
        );
        expect(removedAt(closesAt + 60_000).offense?.cleared).toBe(false);
    });

    it('dates each epoch from the protocol clock', () => {
        const [entry] = sequencerHistory(
            projectCases([inactive('8', 1)], protocol('20')),
            protocol('20'),
        );
        // genesis 1,000,000 s + epoch 8 × 32 slots × 72 s.
        expect(entry.epochStartsAt).toBe(new Date((1_000_000 + 8 * 32 * 72) * 1_000).toISOString());
        expect(sequencerHistory(projectCases([inactive('8', 1)], null), null)[0].epochStartsAt)
            .toBeNull();
    });

    it('describes a missed duty without counts as not inactive', () => {
        const [entry] = sequencerHistory(
            projectCases([miss('40', { status: 'checkpoint-missed' })], protocol('20')),
            protocol('20'),
        );
        expect(historySentences(entry, protocol('20'))[0])
            .toBe('Missed its checkpoint proposal. Not an inactive epoch (under 70% of duties missed).');
    });

    it('keeps an open case open and says where it stands', () => {
        const [entry] = sequencerHistory(projectCases([
            observation('candidate', 'l1_round', '12', {
                round: '5',
                status: 'quorum-reached',
                stable: false,
                support: 70,
                quorum: 65,
                amount: SMALL,
            }, 'ethereum_l1'),
        ], protocol('5')), protocol('5'));

        expect(entry.outcome).toBe('open');
        expect(entry.slashNumber).toBeNull();
        expect(historyOutcomeLabel(entry)).toBe('Open');
        expect(historySentences(entry, protocol('5'))).toEqual([
            'L1 voting round 5: 70 votes (quorum 65) for a 2,000 AZTEC slash.',
            'Now: 2,000 AZTEC candidate.',
        ]);
    });
});

function slashed(epoch: string, round: string, streak: number, support: number): Observation[] {
    return [
        inactive(epoch, streak),
        observation(`offense-${epoch}`, 'node_offense', epoch, {
            id: `offense-${epoch}`,
            status: 'active',
            offenseTypeName: 'inactivity',
            amount: SMALL,
            expectedRound: round,
        }, 'aztec_node'),
        observation(`round-${epoch}`, 'l1_round', epoch, {
            round,
            status: 'executed',
            isExecuted: true,
            stable: true,
            support,
            quorum: 65,
            amount: SMALL,
            executableAt: '2026-09-12T07:47:11.000Z',
        }, 'ethereum_l1'),
        {
            ...observation(`slash-${epoch}`, 'l1_slash', epoch, {
                round,
                amount: SMALL,
            }, 'ethereum_l1'),
            provenance: {
                observedAt: '2026-09-12T07:48:00.000Z',
                transactionHash: TX,
                canonical: true,
            },
        },
    ];
}

function inactive(epoch: string, streak: number): Observation {
    return observation(`inactive-${epoch}`, 'inactivity_epoch', epoch, {
        missed: 32,
        total: 32,
        streak,
        threshold: 2,
    }, 'aztec_sentinel');
}

function miss(epoch: string, data: Record<string, unknown>): Observation {
    return observation(`miss-${epoch}`, 'duty_miss', epoch, data, 'aztec_sentinel');
}

function observation(
    id: string,
    kind: Observation['kind'],
    targetEpoch: string,
    data: Record<string, unknown>,
    source: Observation['source'],
): Observation {
    return {
        id,
        network: 'mainnet',
        source,
        kind,
        sequencer,
        lineageId,
        targetEpoch,
        provenance: {
            observedAt: `2026-09-0${Math.min(9, Number(targetEpoch) % 9 + 1)}T00:00:00.000Z`,
            canonical: true,
        },
        data,
    };
}

function protocol(currentRound: string): ProtocolSnapshot {
    return {
        network: 'mainnet',
        chainId: 1,
        observedAt: '2026-09-20T00:00:00.000Z',
        blockNumber: '1',
        blockHash: `0x${'11'.repeat(32)}`,
        registryAddress: '0x3333333333333333333333333333333333333333',
        rollupAddress: '0x4444444444444444444444444444444444444444',
        genesisTime: '1000000',
        currentSlot: '0',
        currentEpoch: '0',
        slotDurationSeconds: 72,
        epochDurationSlots: 32,
        inactivity: { targetPercentage: 0.7, consecutiveEpochs: 2 },
        lineages: [{
            role: 'active',
            rollupAddress: '0x4444444444444444444444444444444444444444',
            slasherAddress: '0x5555555555555555555555555555555555555555',
            proposerAddress: lineageId,
            currentRound,
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
            },
        }],
    };
}
