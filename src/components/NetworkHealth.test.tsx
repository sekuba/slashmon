import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NetworkHealth } from './NetworkHealth';

describe('NetworkHealth', () => {
    it('uses the Slashing Timeline language and phase colors', () => {
        const markup = renderToStaticMarkup(
            <NetworkHealth
                protocol={null}
                summary={{
                    activeCases: 7,
                    precursors: 1,
                    nodeOffenses: 2,
                    l1Supported: 3,
                    candidates: 4,
                    executable: 5,
                    actualSlashes: 6,
                    ejections: 7,
                    stakeAtRisk: '0',
                }}
            />,
        );

        expect(markup).toMatch(/border-orchid bg-aubergine text-orchid[^>]*>.*Duty misses/);
        expect(markup).toMatch(/border-aqua bg-lapis text-aqua[^>]*>.*L1 votes/);
        expect(markup).toMatch(/border-vermillion bg-oxblood text-vermillion[^>]*>.*Executable/);
        expect(markup).toMatch(/border-chartreuse bg-malachite text-chartreuse[^>]*>.*Stake removed/);
    });
});
