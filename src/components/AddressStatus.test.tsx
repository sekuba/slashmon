import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SlashingCase } from '@shared/protocol/index.ts';
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

    it('collapses timelines until a linked case is selected', () => {
        const entry = item('selected', true, null, null);
        const common = {
            address: entry.sequencer,
            network: 'mainnet' as const,
            cases: [entry],
            currentStake: null,
            currentStakeLoading: false,
            protocol: null,
            onOpenProtocolGuide: () => undefined,
        };
        const collapsed = renderToStaticMarkup(
            <AddressStatus {...common} selectedCaseId={null} />,
        );
        const expanded = renderToStaticMarkup(
            <AddressStatus {...common} selectedCaseId={entry.id} />,
        );

        expect(collapsed.split('Open cases')).toHaveLength(3);
        expect(collapsed).not.toContain('Closed cases');
        expect(collapsed).toContain(`https://dashtec.xyz/sequencers/${entry.sequencer}`);
        expect(collapsed).not.toContain('<details open');
        expect(expanded).toContain('<details open');
    });

    it('moves closed cases into their own collapsed group', () => {
        const open = item('open', true, '2000000000000000000000', null);
        const closed = item('closed', false, null, null);
        const common = {
            address: open.sequencer,
            network: 'mainnet' as const,
            currentStake: null,
            currentStakeLoading: false,
            protocol: null,
            archiveNote: 'Kept for 7 days.',
            onOpenProtocolGuide: () => undefined,
        };
        const markup = renderToStaticMarkup(
            <AddressStatus {...common} cases={[open, closed]} selectedCaseId={null} />,
        );
        const closedOnly = renderToStaticMarkup(
            <AddressStatus {...common} cases={[closed]} selectedCaseId={closed.id} />,
        );

        expect(markup).toContain('1 open');
        expect(markup).toContain('Open cases');
        expect(markup).toContain('Closed cases');
        expect(markup).toContain('These cases are final. Kept for 7 days.');
        expect(markup).not.toContain('<details open');
        expect(closedOnly).toContain('Clear');
        expect(closedOnly).toContain('No open slashing cases');
        // Only the summary fact remains; there is no open-case group.
        expect(closedOnly.split('Open cases')).toHaveLength(2);
        expect(closedOnly).toContain('<details open');
    });

    it('qualifies an empty address as having no recent evidence', () => {
        const markup = renderToStaticMarkup(
            <AddressStatus
                address="0x1111111111111111111111111111111111111111"
                network="mainnet"
                cases={[]}
                currentStake={null}
                currentStakeLoading={false}
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
});

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
