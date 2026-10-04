import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProtocolSnapshot } from '@shared/protocol/index.ts';
import { formatDuration, ProtocolGuide } from './ProtocolGuide';

describe('ProtocolGuide', () => {
    it('explains every stage with a concise three-part structure', () => {
        const markup = renderToStaticMarkup(
            <ProtocolGuide isOpen protocol={null} onClose={() => undefined} />,
        );

        expect(markup).toContain('Explained');
        expect(markup).toContain('Slashing Timeline');
        expect(markup).toContain('Node evidence');
        expect(markup).toContain('L1 Voting');
        expect(markup).toContain('Slashing');
        for (const label of [
            'Duty miss',
            'Node offense',
            'L1 votes',
            'Candidate',
            'Execution delay',
            'Executable',
            'Executed',
            'Stake removed',
            'Ejection',
        ]) {
            expect(markup).toContain(label);
        }
        expect(markup).toContain('Offenses');
        expect(markup).toContain('Slash appeals');
        expect(markup).toContain('https://github.com/aztec-slash-veto/council');
        expect(markup).not.toContain('Can stop here');
        expect(markup).not.toContain('Three facts that must stay separate');
        expect(markup).not.toContain('Exemplary');
        expect(markup).not.toContain('Target offset');
    });

    it('uses the live lineage parameters when opened from a case', () => {
        const markup = renderToStaticMarkup(
            <ProtocolGuide
                isOpen
                protocol={protocol()}
                onClose={() => undefined}
            />,
        );

        expect(markup).toContain('quorum 7');
        expect(markup).toContain('R − 3');
        expect(markup).toContain('8m');
        expect(markup).toContain('16m');
    });

    it('formats exact protocol durations without hiding seconds', () => {
        expect(formatDuration(258_048)).toBe('2d 23h 40m 48s');
        expect(formatDuration(345_600)).toBe('4d');
        expect(formatDuration(0)).toBe('0s');
    });

    it('states the stake to join, penalty sizes, and the ejection threshold', () => {
        const base = protocol();
        const markup = renderToStaticMarkup(
            <ProtocolGuide
                isOpen
                protocol={{
                    ...base,
                    staking: {
                        activationThreshold: '200000000000000000000000',
                        localEjectionThreshold: '190000000000000000000000',
                        exitDelaySeconds: 345_600,
                    },
                    lineages: [{
                        ...base.lineages[0],
                        parameters: {
                            ...base.lineages[0].parameters,
                            slashAmounts: [
                                '2000000000000000000000',
                                '5000000000000000000000',
                                '5000000000000000000000',
                            ],
                        },
                    }],
                }}
                onClose={() => undefined}
            />,
        );

        expect(markup).toContain('Stake, ejection, and zombies');
        expect(markup).toContain('200,000 AZTEC');
        expect(markup).toContain('2,000 / 5,000 / 5,000 AZTEC');
        expect(markup).toContain('190,000 AZTEC');
        expect(markup).toContain(
            'From a full stake, the 6th 2,000 AZTEC slash or the 3rd 5,000 AZTEC slash ejects.',
        );
        expect(markup).toContain('When a slash leaves the stake below 190,000 AZTEC');
        expect(markup).toContain('can claim it 4d after');
    });

    it('explains ejection without numbers when the source has none', () => {
        const markup = renderToStaticMarkup(
            <ProtocolGuide isOpen protocol={protocol()} onClose={() => undefined} />,
        );
        expect(markup).toContain('Stake, ejection, and zombies');
        expect(markup).toContain('below the Rollup’s local ejection threshold');
    });
});

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
        currentSlot: '100',
        currentEpoch: '10',
        slotDurationSeconds: 60,
        epochDurationSlots: 4,
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
                roundSizeSlots: 8,
                roundSizeEpochs: 2,
                executionDelayRounds: 2,
                lifetimeRounds: 4,
                slashOffsetRounds: 3,
                committeeSize: 8,
            },
        }],
    };
}
