import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SlashingCase } from '@shared/protocol/index.ts';
import { CaseTimeline } from './CaseTimeline';

describe('CaseTimeline', () => {
    it('uses a compact case share action and links the abbreviated path to education', () => {
        const markup = renderToStaticMarkup(
            <CaseTimeline
                item={item()}
                protocol={null}
                showSequencer
                onOpenProtocolGuide={() => undefined}
            />,
        );

        expect(markup).toContain('aria-label="Copy link to this case"');
        expect(markup).toContain(
            'https://dashtec.xyz/sequencers/0x1111111111111111111111111111111111111111',
        );
        expect(markup).toContain('Explain timeline');
        expect(markup).toContain('Duty miss');
        expect(markup).toContain('Ejection');
        expect(markup).not.toContain('Link this case');
        expect(markup).not.toContain('Clear case link');
    });
});

function item(): SlashingCase {
    return {
        id: 'case:mainnet:lineage:0x1111111111111111111111111111111111111111:42',
        network: 'mainnet',
        sequencer: '0x1111111111111111111111111111111111111111',
        lineageId: '0x2222222222222222222222222222222222222222',
        targetEpoch: '42',
        firstObservedAt: '2026-07-29T00:00:00.000Z',
        lastObservedAt: '2026-07-29T00:00:00.000Z',
        observations: [],
        state: {
            stage: 'l1_support',
            urgency: 'warning',
            headline: '3 of 65 L1 ballots support a penalty',
            explanation: 'L1 ballots target this sequencer.',
            reason: {
                label: 'Reason unknown on L1',
                provenance: 'unknown_on_l1',
                evidenceIds: [],
            },
            nextTransition: null,
            requestedAmount: null,
            actualAmount: null,
            payloadAddress: null,
            round: '12',
            active: true,
        },
    };
}
