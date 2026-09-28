import { describe, expect, it } from 'vitest';
import {
    projectAddressStatus,
    projectCases,
} from './cases.ts';
import { transitionFor } from './transitions.ts';
import type { Observation, ProtocolSnapshot } from './types.ts';

const sequencer = '0x1111111111111111111111111111111111111111';
const lineageId = '0x2222222222222222222222222222222222222222';

describe('case projection', () => {
    it('keeps an inactivity precursor distinct from an offense', () => {
        const cases = projectCases([
            observation('inactive', 'inactivity_epoch', {
                streak: 1,
                threshold: 2,
                missed: 7,
                total: 8,
            }),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'precursor',
            headline: '1 of 2 qualifying inactive epochs',
            reason: {
                label: 'Inactivity',
                provenance: 'node_evidence',
            },
        });
    });

    it('attaches node evidence without claiming it is the L1 reason', () => {
        const cases = projectCases([
            observation('offense', 'node_offense', {
                status: 'active',
                offenseTypeName: 'inactivity',
                amount: '2000000000000000000000',
                expectedRound: '12',
            }),
            observation('candidate', 'l1_round', {
                round: '12',
                status: 'quorum-reached',
                stable: true,
                support: 65,
                quorum: 65,
                amount: '2000000000000000000000',
                payloadAddress: '0x3333333333333333333333333333333333333333',
                executableSlot: '4096',
                executableAt: '2026-07-31T12:00:00.000Z',
            }, 'ethereum_l1'),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'delayed',
            headline: '2,000 AZTEC candidate',
            reason: {
                label: 'Inactivity',
                provenance: 'node_evidence',
            },
        });
    });

    it('uses the Slashed amount as the actual outcome', () => {
        const cases = projectCases([
            observation('candidate', 'l1_round', {
                round: '12',
                status: 'executed',
                isExecuted: true,
                amount: '5000000000000000000000',
            }, 'ethereum_l1'),
            observation('slash', 'l1_slash', {
                round: '12',
                amount: '2000000000000000000000',
            }, 'ethereum_l1'),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'stake_removed',
            actualAmount: '2000000000000000000000',
            requestedAmount: null,
        });
    });

    it('does not call an executed empty action a slash', () => {
        const cases = projectCases([
            observation('support', 'l1_round', {
                round: '12',
                status: 'executed',
                isExecuted: true,
                amount: null,
                support: 12,
                quorum: 65,
            }, 'ethereum_l1'),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'resolved',
            headline: 'Round executed without slashing this sequencer',
            active: false,
        });
    });

    it('keeps a requested amount visible while the browser scans the receipt', () => {
        const cases = projectCases([
            observation('executed', 'l1_round', {
                round: '12',
                status: 'executed',
                isExecuted: true,
                amount: '2000000000000000000000',
                executionReceiptStatus: 'scanning',
            }, 'ethereum_l1'),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'executed',
            headline: 'Round executed · 2,000 AZTEC requested',
            requestedAmount: '2000000000000000000000',
        });
        expect(cases[0].state.explanation).toContain(
            'scanning for its execution receipt',
        );
    });

    it('uses an inspected execution receipt as a terminal non-slash outcome', () => {
        const cases = projectCases([
            observation('executed', 'l1_round', {
                round: '12',
                status: 'executed',
                isExecuted: true,
                amount: '2000000000000000000000',
                executionReceiptStatus: 'inspected',
            }, 'ethereum_l1'),
            {
                ...observation('receipt', 'l1_execution', {
                    round: '12',
                    slashCount: '1',
                    actionIndex: 0,
                }, 'ethereum_l1'),
                provenance: {
                    observedAt: '2026-07-29T12:01:00.000Z',
                    blockNumber: '123',
                    blockHash: `0x${'12'.repeat(32)}`,
                    transactionHash: `0x${'34'.repeat(32)}`,
                    canonical: true,
                },
            },
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'resolved',
            headline: 'Round executed · 2,000 AZTEC requested',
            active: false,
        });
        expect(cases[0].state.explanation).toContain(
            'contains no Rollup Slashed log',
        );
    });

    it('treats escape-hatch exclusion as a terminal non-slash outcome', () => {
        const cases = projectCases([
            observation('escaped', 'l1_round', {
                round: '12',
                status: 'below-quorum',
                escaped: true,
                support: 65,
                quorum: 65,
            }, 'ethereum_l1'),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'resolved',
            headline: 'Excluded by the censorship-resistance escape hatch',
            active: false,
        });
    });

    it('keeps actual deduction distinct from ejection state', () => {
        const cases = projectCases([
            observation('slash', 'l1_slash', {
                round: '12',
                amount: '2000000000000000000000',
            }, 'ethereum_l1'),
            observation('status', 'stake_status', {
                ejected: true,
                status: 'exiting',
                actualAmount: '2000000000000000000000',
            }, 'ethereum_l1'),
        ], protocol());

        expect(cases[0].state).toMatchObject({
            stage: 'ejected',
            actualAmount: '2000000000000000000000',
            active: false,
        });
    });

    it('selects the most urgent active case for an address', () => {
        const cases = projectCases([
            observation('inactive', 'inactivity_epoch', { streak: 1, threshold: 2 }),
            { ...observation('candidate', 'l1_round', {
                round: '12',
                status: 'executable',
                amount: '2000000000000000000000',
            }, 'ethereum_l1'), targetEpoch: '11' },
        ], protocol());

        expect(projectAddressStatus(sequencer, cases).activeCase?.state.stage)
            .toBe('executable');
    });

    it('creates transitions only for meaningful state changes', () => {
        const first = projectCases([
            observation('inactive', 'inactivity_epoch', { streak: 1, threshold: 2 }),
        ], protocol())[0];
        const same = projectCases([
            observation('inactive', 'inactivity_epoch', { streak: 1, threshold: 2 }),
        ], protocol())[0];
        const next = projectCases([
            observation('inactive', 'inactivity_epoch', { streak: 1, threshold: 2 }),
            observation('offense', 'node_offense', {
                status: 'active',
                offenseTypeName: 'inactivity',
            }),
        ], protocol())[0];

        expect(transitionFor(first, same)).toBeNull();
        expect(transitionFor(first, next)).toMatchObject({
            fromStage: 'precursor',
            toStage: 'node_offense',
            severity: 'warning',
        });
    });

    it('notifies on the first L1 vote and quorum, not each ballot increment', () => {
        const offense = {
            ...observation('offense', 'node_offense', {
                status: 'active',
                offenseTypeName: 'inactivity',
                amount: '2000000000000000000000',
                expectedRound: '12',
            }),
            provenance: {
                observedAt: '2026-07-29T11:00:00.000Z',
                canonical: true,
            },
        };
        const firstVote = projectCases([
            offense,
            observation('vote-1', 'l1_round', {
                round: '12',
                status: 'below-quorum',
                support: 1,
                quorum: 65,
                amount: null,
            }, 'ethereum_l1'),
        ], protocol())[0];
        const secondVote = projectCases([
            offense,
            observation('vote-2', 'l1_round', {
                round: '12',
                status: 'below-quorum',
                support: 2,
                quorum: 65,
                amount: null,
            }, 'ethereum_l1'),
        ], protocol())[0];
        const quorum = projectCases([
            offense,
            observation('quorum', 'l1_round', {
                round: '12',
                status: 'quorum-reached',
                support: 65,
                quorum: 65,
                amount: '2000000000000000000000',
                payloadAddress: '0x3333333333333333333333333333333333333333',
            }, 'ethereum_l1'),
        ], protocol())[0];

        expect(transitionFor(null, firstVote)).toMatchObject({
            title: '0x1111…1111 · L1 mention',
            body: [
                'Event: First L1 slash vote recorded',
                'Epoch: 40',
                'Round: 12',
                'Time: 2026-07-29 12:00:06 UTC',
                'Reason: Inactivity (node evidence)',
            ].join('\n'),
        });
        expect(transitionFor(firstVote, secondVote)).toBeNull();
        expect(transitionFor(firstVote, quorum)).toMatchObject({
            title: '0x1111…1111 · Candidate',
            body: [
                'Event: Quorum reached for a 2,000 AZTEC slash',
                'Epoch: 40',
                'Round: 12',
                'Time: 2026-07-29 12:00:06 UTC',
                'Reason: Inactivity (node evidence)',
                'Next: Voting closes',
            ].join('\n'),
        });
    });

    it('includes the relevant slot, epoch, and observation time', () => {
        const duty = projectCases([{
            ...observation('duty', 'duty_miss', {
                epoch: 10,
                slot: '9001',
                status: 'attestation-missed',
            }),
            slot: '9001',
        }], protocol())[0];

        expect(transitionFor(null, duty)).toMatchObject({
            title: '0x1111…1111 · Duty miss',
            body: [
                'Event: Duty missed',
                'Epoch: 40',
                'Slot: 9001',
                'Time: 2026-07-29 12:00:04 UTC',
                'Reason: Inactivity (node evidence)',
            ].join('\n'),
        });
    });

    it('names other offense types without repeating them', () => {
        const offense = projectCases([{
            ...observation('duplicate', 'node_offense', {
                status: 'active',
                offenseTypeName: 'duplicate_proposal',
                amount: '5000000000000000000000',
                expectedRound: '12',
            }),
            slot: '9001',
        }], protocol())[0];

        expect(transitionFor(null, offense)).toMatchObject({
            title: '0x1111…1111 · Awaiting L1 round',
            body: [
                'Event: Offense recorded by this node',
                'Epoch: 40',
                'Slot: 9001',
                'Round: 12',
                'Time: 2026-07-29 12:00:09 UTC',
                'Reason: Duplicate Proposal (node evidence)',
            ].join('\n'),
        });
    });
});

// Epoch 40 is voted on in round 12; with a 34-round lifetime its candidate
// can execute through round 46.
describe('case closing', () => {
    const duty = observation('inactive', 'inactivity_epoch', { streak: 1, threshold: 2 });
    const offense = observation('offense', 'node_offense', {
        status: 'active',
        offenseTypeName: 'inactivity',
        amount: '2000000000000000000000',
        expectedRound: '12',
    }, 'aztec_node');
    const candidate = (data: Record<string, unknown>) => observation('round', 'l1_round', {
        round: '12',
        support: 65,
        quorum: 65,
        amount: '2000000000000000000000',
        payloadAddress: '0x3333333333333333333333333333333333333333',
        ...data,
    }, 'ethereum_l1');

    it('closes duty evidence once its voting round closes without a ballot', () => {
        expect(projectCases([duty], protocol('12'))[0].state).toMatchObject({
            stage: 'precursor',
            active: true,
        });
        expect(projectCases([duty], protocol('13'))[0].state).toMatchObject({
            stage: 'resolved',
            urgency: 'normal',
            headline: 'Closed without an L1 vote',
            round: '12',
            active: false,
        });
    });

    it('closes a node offense without a ballot even after the node withdraws it', () => {
        const withdrawn = {
            ...observation('withdrawn', 'node_offense', {
                status: 'withdrawn',
                offenseTypeName: 'inactivity',
                expectedRound: '12',
            }, 'aztec_node'),
            provenance: { observedAt: '2026-07-29T13:00:00.000Z', canonical: true },
        };

        expect(projectCases([offense], protocol('12'))[0].state.stage).toBe('node_offense');
        for (const evidence of [[offense], [offense, withdrawn]]) {
            expect(projectCases(evidence, protocol('13'))[0].state).toMatchObject({
                stage: 'resolved',
                headline: 'Inactivity · no L1 vote before voting closed',
                requestedAmount: null,
                active: false,
            });
        }
    });

    it('closes L1 support below quorum once the round closes', () => {
        const vote = observation('vote', 'l1_round', {
            round: '12',
            status: 'below-quorum',
            support: 3,
            quorum: 65,
            amount: null,
            stable: false,
        }, 'ethereum_l1');

        expect(projectCases([vote], protocol('12'))[0].state.stage).toBe('l1_support');
        for (const closed of [
            projectCases([vote], protocol('13'))[0],
            projectCases([{ ...vote, data: { ...vote.data, stable: true } }], null)[0],
        ]) {
            expect(closed.state).toMatchObject({
                stage: 'resolved',
                headline: 'Voting closed below quorum',
                active: false,
            });
        }
    });

    it('expires a candidate after its lifetime although the last scan saw it executable', () => {
        const executable = candidate({ status: 'executable', stable: true });

        expect(projectCases([executable], protocol('46'))[0].state).toMatchObject({
            stage: 'executable',
            active: true,
        });
        expect(projectCases([executable], protocol('47'))[0].state).toMatchObject({
            stage: 'expired',
            requestedAmount: '2000000000000000000000',
            active: false,
        });
    });

    it('keeps a vetoed candidate open only while its tally can still change', () => {
        const vetoed = candidate({ status: 'quorum-reached', isVetoed: true, stable: false });

        expect(projectCases([vetoed], protocol('12'))[0].state).toMatchObject({
            stage: 'vetoed',
            active: true,
        });
        for (const round of ['13', '47']) {
            expect(projectCases([vetoed], protocol(round))[0].state).toMatchObject({
                stage: 'vetoed',
                headline: 'Exact candidate payload is vetoed',
                active: false,
            });
        }
    });

    it('does not close a case by time without its lineage clock', () => {
        expect(projectCases([duty], null)[0].state.active).toBe(true);
    });

    it('lets only open cases and confirmed slashes headline an address', () => {
        const closed = projectCases([duty], protocol('13'));
        const slashed = projectCases([
            duty,
            { ...observation('slash', 'l1_slash', {
                round: '12',
                amount: '2000000000000000000000',
            }, 'ethereum_l1'), targetEpoch: '44' },
        ], protocol('13'));

        expect(projectAddressStatus(sequencer, closed)).toMatchObject({
            headline: 'No open slashing cases',
            urgency: 'normal',
            activeCase: null,
        });
        expect(projectAddressStatus(sequencer, slashed)).toMatchObject({
            headline: '2,000 AZTEC removed from stake',
            urgency: 'critical',
            activeCase: null,
        });
    });

    it('alerts when warned evidence closes, and closes duty misses silently', () => {
        const openOffense = projectCases([offense], protocol('12'))[0];
        const closedOffense = projectCases([offense], protocol('13'))[0];
        const openDuty = projectCases([duty], protocol('12'))[0];
        const closedDuty = projectCases([duty], protocol('13'))[0];

        expect(transitionFor(openOffense, closedOffense, '2026-07-29T15:00:00.000Z'))
            .toMatchObject({
                fromStage: 'node_offense',
                toStage: 'resolved',
                severity: 'info',
                observedAt: '2026-07-29T15:00:00.000Z',
                body: expect.stringContaining('Time: 2026-07-29 15:00:00 UTC'),
            });
        expect(transitionFor(openDuty, closedDuty)).toBeNull();
        expect(transitionFor(null, closedDuty)).toBeNull();
        expect(transitionFor(closedDuty, closedOffense)).toBeNull();
    });

    it('does not repeat an offense alert when its voting round opens', () => {
        const awaiting = projectCases([offense], protocol('11'))[0];
        const voting = projectCases([offense], protocol('12'))[0];

        expect(awaiting.state.stage).toBe('awaiting_round');
        expect(voting.state.stage).toBe('node_offense');
        expect(transitionFor(awaiting, voting)).toBeNull();
    });

    it('alerts when a candidate expires', () => {
        const executable = candidate({ status: 'executable', stable: true });

        expect(transitionFor(
            projectCases([executable], protocol('46'))[0],
            projectCases([executable], protocol('47'))[0],
        )).toMatchObject({
            toStage: 'expired',
            body: expect.stringContaining('Event: Slash candidate expired'),
        });
    });
});

function observation(
    id: string,
    kind: Observation['kind'],
    data: Record<string, unknown>,
    source: Observation['source'] = 'aztec_sentinel',
): Observation {
    return {
        id,
        network: 'mainnet',
        source,
        kind,
        sequencer,
        lineageId,
        targetEpoch: '40',
        provenance: {
            observedAt: `2026-07-29T12:00:0${id.length % 10}.000Z`,
            canonical: true,
        },
        data,
    };
}

function protocol(currentRound = '11'): ProtocolSnapshot {
    return {
        network: 'mainnet',
        chainId: 1,
        observedAt: '2026-07-29T12:00:00.000Z',
        blockNumber: '1',
        blockHash: `0x${'ab'.repeat(32)}`,
        registryAddress: '0x4444444444444444444444444444444444444444',
        rollupAddress: '0x5555555555555555555555555555555555555555',
        genesisTime: '1700000000',
        currentSlot: '1000',
        currentEpoch: '31',
        slotDurationSeconds: 72,
        epochDurationSlots: 32,
        inactivity: { targetPercentage: 0.8, consecutiveEpochs: 2 },
        lineages: [{
            role: 'active',
            rollupAddress: '0x5555555555555555555555555555555555555555',
            slasherAddress: '0x6666666666666666666666666666666666666666',
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
