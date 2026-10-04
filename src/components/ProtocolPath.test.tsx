import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Observation, SlashingCase } from '@shared/protocol/index.ts';
import { ProtocolPath } from './ProtocolPath';

describe('ProtocolPath', () => {
    it('does not invent completed local stages for an L1-only case', () => {
        const markup = renderToStaticMarkup(
            <ProtocolPath
                item={item('l1_support', [round({ support: 4 })])}
                onOpenGuide={() => undefined}
            />,
        );

        expect(markup).toMatch(/text-whisper-white\/45[^>]*><span[^>]*>1<\/span>Duty miss/);
        expect(markup).toMatch(/aria-current="step"[^>]*><span[^>]*>3<\/span>L1 votes/);
        expect(markup).toContain('Slashing timeline');
        expect(markup).toContain('brutal-border-pulse');
        expect(markup).toContain('--pulse-color:var(--color-aqua)');
    });

    it('shows an expired candidate as a stopped path, not a live candidate step', () => {
        const markup = renderToStaticMarkup(
            <ProtocolPath
                item={item('expired', [round({
                    amount: '2000000000000000000000',
                    stable: true,
                    status: 'expired',
                })])}
                onOpenGuide={() => undefined}
            />,
        );

        expect(markup).not.toContain('aria-current="step"');
        expect(markup).not.toContain('brutal-border-pulse');
        expect(markup).toMatch(/text-aqua[^>]*><span[^>]*>✓<\/span>Candidate/);
    });

    it('keeps a terminal current rectangle still', () => {
        const markup = renderToStaticMarkup(
            <ProtocolPath
                item={item('executed', [round({
                    amount: '2000000000000000000000',
                    isExecuted: true,
                    status: 'executed',
                })], false)}
                onOpenGuide={() => undefined}
            />,
        );

        expect(markup).toContain('aria-current="step"');
        expect(markup).not.toContain('brutal-border-pulse');
    });
});

function item(
    stage: SlashingCase['state']['stage'],
    observations: Observation[],
    active = stage !== 'expired',
): SlashingCase {
    return {
        id: `case:${stage}`,
        network: 'mainnet',
        sequencer: '0x1111111111111111111111111111111111111111',
        lineageId: '0x2222222222222222222222222222222222222222',
        targetEpoch: '42',
        firstObservedAt: '2026-07-29T00:00:00.000Z',
        lastObservedAt: '2026-07-29T00:00:00.000Z',
        observations,
        state: {
            stage,
            urgency: 'warning',
            headline: stage,
            explanation: stage,
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
            active,
        },
    };
}

function round(data: Record<string, unknown>): Observation {
    return {
        id: 'round',
        network: 'mainnet',
        source: 'ethereum_l1',
        kind: 'l1_round',
        sequencer: '0x1111111111111111111111111111111111111111',
        lineageId: '0x2222222222222222222222222222222222222222',
        targetEpoch: '42',
        provenance: {
            observedAt: '2026-07-29T00:00:00.000Z',
            canonical: true,
        },
        data,
    };
}
