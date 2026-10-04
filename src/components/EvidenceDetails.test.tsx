import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Observation, ProtocolSnapshot, SlashingCase } from '@shared/protocol/index.ts';
import { EvidenceDetails } from './EvidenceDetails';

const SEQUENCER = '0x1111111111111111111111111111111111111111';
const LINEAGE = '0x2222222222222222222222222222222222222222';
const PAYLOAD = '0x3333333333333333333333333333333333333333';
const TRANSACTION = `0x${'44'.repeat(32)}`;

describe('EvidenceDetails', () => {
    it('combines an exact historical round and slash into one execution card', () => {
        const markup = renderToStaticMarkup(
            <EvidenceDetails
                item={item([
                    observation('l1_round', {
                        historicalExecution: true,
                        actionIndex: 1,
                        support: 125,
                        quorum: 65,
                        amount: '2000000000000000000000',
                        payloadAddress: PAYLOAD,
                    }),
                    observation('l1_slash', {
                        actionIndex: 1,
                        amount: '1500000000000000000000',
                    }),
                ])}
                protocol={null}
            />,
        );

        expect(markup).toContain('Evidence &amp; protocol details (1)');
        expect(markup).toContain('Ethereum L1 · Executed slash');
        expect(markup).not.toContain('Ethereum L1 · Voting round');
        expect(markup).not.toContain('Ethereum L1 · Stake slashed');
        expect(markup).toContain('L1 support:');
        expect(markup).toContain('125 / 65');
        expect(markup).toContain('Requested:');
        expect(markup).toContain('2,000 AZTEC');
        expect(markup).toContain('Actual:');
        expect(markup).toContain('1,500 AZTEC');
        expect(markup).toContain(PAYLOAD);
    });

    it('keeps a live round and slash as separate evidence', () => {
        const markup = renderToStaticMarkup(
            <EvidenceDetails
                item={item([
                    observation('l1_round', {
                        actionIndex: 1,
                        amount: '2000000000000000000000',
                    }),
                    observation('l1_slash', {
                        actionIndex: 1,
                        amount: '2000000000000000000000',
                    }),
                ])}
                protocol={null}
            />,
        );

        expect(markup).toContain('Evidence &amp; protocol details (2)');
        expect(markup).toContain('Ethereum L1 · Voting round');
        expect(markup).toContain('Ethereum L1 · Stake slashed');
        expect(markup).not.toContain('Ethereum L1 · Executed slash');
    });

    it('states node evidence facts and merges repeated reports of one offense', () => {
        const offense = {
            id: 'offense-1',
            offenseTypeName: 'inactivity',
            amount: '2000000000000000000000',
            epochOrSlot: '941',
            timeUnit: 'epoch',
            expectedRound: '237',
        };
        const markup = renderToStaticMarkup(
            <EvidenceDetails
                item={item([
                    nodeObservation('reported', 'node_offense', 'aztec_node', {
                        ...offense,
                        status: 'active',
                    }),
                    nodeObservation('inactive', 'inactivity_epoch', 'aztec_sentinel', {
                        missed: 32,
                        total: 32,
                        streak: 2,
                        threshold: 2,
                        firstMissedSlot: '30112',
                        lastMissedSlot: '30143',
                    }),
                    nodeObservation('withdrawn', 'node_offense', 'aztec_node', {
                        ...offense,
                        status: 'withdrawn',
                    }),
                ])}
                protocol={null}
            />,
        );

        expect(markup).toContain('Evidence &amp; protocol details (2)');
        expect(markup).toContain('Aztec node · Node offense');
        expect(markup).toContain('Inactivity');
        expect(markup).toContain('2,000 AZTEC');
        expect(markup).toContain('epoch 941');
        expect(markup).toContain('Node pending list: </dt><dd class="inline break-all">Removed ');
        const withClock = renderToStaticMarkup(
            <EvidenceDetails
                item={item([
                    nodeObservation('reported', 'node_offense', 'aztec_node', {
                        ...offense,
                        status: 'active',
                    }),
                    nodeObservation('withdrawn', 'node_offense', 'aztec_node', {
                        ...offense,
                        status: 'withdrawn',
                    }),
                ])}
                protocol={protocol()}
            />,
        );
        expect(withClock).toContain('Expired after voting round 237 closed');
        expect(markup).toContain('Sentinel · Inactive epoch');
        expect(markup).toContain('32 of 32 duties');
        expect(markup).toContain('2 (offense at 2)');
        expect(markup).toContain('30112–30143');
    });
});

function protocol(): ProtocolSnapshot {
    return {
        network: 'mainnet',
        chainId: 1,
        observedAt: '2026-07-29T19:05:05.474Z',
        blockNumber: '1',
        blockHash: `0x${'11'.repeat(32)}`,
        registryAddress: '0x5555555555555555555555555555555555555555',
        rollupAddress: '0x6666666666666666666666666666666666666666',
        genesisTime: '0',
        currentSlot: '0',
        currentEpoch: '0',
        slotDurationSeconds: 72,
        epochDurationSlots: 32,
        inactivity: null,
        lineages: [{
            role: 'active',
            rollupAddress: '0x6666666666666666666666666666666666666666',
            slasherAddress: '0x7777777777777777777777777777777777777777',
            proposerAddress: LINEAGE,
            currentRound: '300',
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

function nodeObservation(
    id: string,
    kind: Observation['kind'],
    source: Observation['source'],
    data: Record<string, unknown>,
): Observation {
    return {
        id,
        network: 'mainnet',
        source,
        kind,
        sequencer: SEQUENCER,
        lineageId: LINEAGE,
        targetEpoch: '941',
        provenance: {
            observedAt: '2026-07-29T19:05:05.474Z',
            canonical: true,
        },
        data,
    };
}

function item(observations: Observation[]): SlashingCase {
    return {
        id: `case:mainnet:${LINEAGE}:${SEQUENCER}:941`,
        network: 'mainnet',
        sequencer: SEQUENCER,
        lineageId: LINEAGE,
        targetEpoch: '941',
        firstObservedAt: '2026-07-29T19:05:05.474Z',
        lastObservedAt: '2026-07-29T19:05:05.474Z',
        observations,
        state: {
            stage: 'stake_removed',
            urgency: 'critical',
            headline: 'Stake removed',
            explanation: 'A canonical Rollup Slashed log confirms the actual deduction.',
            reason: {
                label: 'Reason unknown on L1',
                provenance: 'unknown_on_l1',
                evidenceIds: [],
            },
            nextTransition: null,
            requestedAmount: null,
            actualAmount: '2000000000000000000000',
            payloadAddress: null,
            round: '237',
            active: false,
        },
    };
}

function observation(
    kind: 'l1_round' | 'l1_slash',
    data: Record<string, unknown>,
): Observation {
    return {
        id: kind,
        network: 'mainnet',
        source: 'ethereum_l1',
        kind,
        sequencer: SEQUENCER,
        lineageId: LINEAGE,
        targetEpoch: '941',
        round: '237',
        provenance: {
            observedAt: '2026-07-29T19:05:05.474Z',
            blockNumber: '25632405',
            blockHash: `0x${'55'.repeat(32)}`,
            transactionHash: TRANSACTION,
            canonical: true,
        },
        data,
    };
}
