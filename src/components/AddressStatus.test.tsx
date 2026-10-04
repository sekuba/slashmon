import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProtocolSnapshot, SlashingCase } from '@shared/protocol/index.ts';
import { AddressStatus, summarizeSequencer } from './AddressStatus';

describe('AddressStatus', () => {
    it('summarizes known stake and pending amounts without inferring missing values', () => {
        const pending = item('pending', true, '2000000000000000000000', null);
        const completed = item('completed', false, null, '500000000000000000000');

        expect(summarizeSequencer(
            [pending, completed],
            '197500000000000000000000',
        )).toEqual({
            activeCases: 1,
            pendingAmount: '2000000000000000000000',
            removedAmount: '500000000000000000000',
            currentStake: '197500000000000000000000',
        });
        expect(summarizeSequencer([pending], null).currentStake).toBeNull();
    });

    it('collapses history rows until a linked case is selected', () => {
        const entry = item('selected', true, null, null);
        const common = {
            address: entry.sequencer,
            network: 'mainnet' as const,
            cases: [entry],
            sequencerState: null,
            sequencerStateLoading: false,
            protocol: null,
            onOpenProtocolGuide: () => undefined,
        };
        const collapsed = renderToStaticMarkup(
            <AddressStatus {...common} selectedCaseId={null} />,
        );
        const expanded = renderToStaticMarkup(
            <AddressStatus {...common} selectedCaseId={entry.id} />,
        );

        expect(collapsed).toContain('What happened');
        expect(collapsed).toContain('1 open');
        expect(collapsed).toContain(`https://dashtec.xyz/sequencers/${entry.sequencer}`);
        expect(collapsed).not.toContain('<details open');
        expect(collapsed).not.toContain('Evidence &amp; protocol details');
        expect(expanded).toContain('<details open');
        expect(expanded).toContain('Evidence &amp; protocol details');
    });

    it('headlines every slash and numbers them in epoch order', () => {
        const first = { ...item('first', false, null, '2000000000000000000000'), targetEpoch: '12' };
        const second = { ...item('second', false, null, '2000000000000000000000'), targetEpoch: '16' };
        const markup = renderToStaticMarkup(
            <AddressStatus
                address={first.sequencer}
                network="mainnet"
                cases={[second, first]}
                sequencerState={null}
                sequencerStateLoading={false}
                protocol={null}
                selectedCaseId={null}
                archiveNote="Kept for 7 days."
                onOpenProtocolGuide={() => undefined}
            />,
        );

        expect(markup).toContain('Slashed 2 times · 4,000 AZTEC removed');
        expect(markup).toContain('No open cases');
        expect(markup.indexOf('Slash #1 · −2,000 AZTEC'))
            .toBeLessThan(markup.indexOf('Slash #2 · −2,000 AZTEC'));
        expect(markup.indexOf('Epoch 12')).toBeLessThan(markup.indexOf('Epoch 16'));
        expect(markup).toContain('Kept for 7 days.');
    });

    it('shows the stake against the ejection threshold', () => {
        const markup = renderToStaticMarkup(
            <AddressStatus
                address="0x1111111111111111111111111111111111111111"
                network="mainnet"
                cases={[]}
                sequencerState={{
                    sequencer: '0x1111111111111111111111111111111111111111',
                    status: 'validating',
                    effectiveBalance: 196_000n * 10n ** 18n,
                    exit: null,
                    blockNumber: 1n,
                    blockHash: `0x${'11'.repeat(32)}`,
                }}
                sequencerStateLoading={false}
                protocol={stakingProtocol()}
                selectedCaseId={null}
                onOpenProtocolGuide={() => undefined}
            />,
        );

        expect(markup).toContain('196,000 AZTEC');
        expect(markup).toContain('Validating');
        expect(markup).toContain('Ejected below');
        expect(markup).toContain('190,000 AZTEC');
        expect(markup).toContain('6,000 AZTEC above the 190,000 AZTEC ejection threshold.');
    });

    it('offers older history from a source that keeps it', () => {
        const markup = renderToStaticMarkup(
            <AddressStatus
                address="0x1111111111111111111111111111111111111111"
                network="mainnet"
                cases={[item('closed', false, null, null)]}
                sequencerState={null}
                sequencerStateLoading={false}
                protocol={null}
                selectedCaseId={null}
                loadHistory={() => Promise.resolve([])}
                onOpenProtocolGuide={() => undefined}
            />,
        );

        expect(markup).toContain('Showing every slash, plus other evidence from the last 7 days.');
        expect(markup).toContain('Load 90-day history');
    });

    it('qualifies an empty address as having no recent evidence', () => {
        const markup = renderToStaticMarkup(
            <AddressStatus
                address="0x1111111111111111111111111111111111111111"
                network="mainnet"
                cases={[]}
                sequencerState={null}
                sequencerStateLoading={false}
                protocol={null}
                selectedCaseId={null}
                archiveNote="Kept for 7 days."
                onOpenProtocolGuide={() => undefined}
            />,
        );

        expect(markup).toContain('No recent slashing evidence');
        expect(markup).toContain(
            'No recent slashing evidence is linked to this address. Kept for 7 days.',
        );
    });

    it('sends a source without full history to one that has it', () => {
        const href = '/?view=pingme&watch=0x1111111111111111111111111111111111111111';
        const markup = renderToStaticMarkup(
            <AddressStatus
                address="0x1111111111111111111111111111111111111111"
                network="mainnet"
                cases={[]}
                sequencerState={null}
                sequencerStateLoading={false}
                protocol={null}
                selectedCaseId={null}
                archiveNote="Monitor shows recent slashes only."
                fullHistoryHref={href}
                onOpenProtocolGuide={() => undefined}
            />,
        );

        expect(markup).toContain('Monitor shows recent slashes only.');
        expect(markup).toContain(`href="${href.replace(/&/g, '&amp;')}"`);
        expect(markup).toContain('Full history in PINGME');
    });
});

function stakingProtocol(): ProtocolSnapshot {
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
            activationThreshold: '200000000000000000000000',
            localEjectionThreshold: '190000000000000000000000',
            exitDelaySeconds: 345_600,
        },
        lineages: [],
    };
}

function item(
    id: string,
    active: boolean,
    requestedAmount: string | null,
    actualAmount: string | null,
): SlashingCase {
    return {
        id,
        network: 'mainnet',
        sequencer: '0x1111111111111111111111111111111111111111',
        lineageId: '0x2222222222222222222222222222222222222222',
        targetEpoch: '42',
        firstObservedAt: '2026-07-29T00:00:00.000Z',
        lastObservedAt: '2026-07-29T00:00:00.000Z',
        observations: [],
        state: {
            stage: active ? 'candidate' : 'stake_removed',
            urgency: active ? 'critical' : 'normal',
            headline: id,
            explanation: id,
            reason: {
                label: 'Reason unknown on L1',
                provenance: 'unknown_on_l1',
                evidenceIds: [],
            },
            nextTransition: null,
            requestedAmount,
            actualAmount,
            payloadAddress: null,
            round: '12',
            active,
        },
    };
}
