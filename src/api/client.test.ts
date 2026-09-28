import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendApiClient } from './client';

describe('slashveto.me API client', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('uses the case API and keeps watch authority in the bearer header', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            network: 'mainnet',
            addresses: [],
            endpoints: [],
            createdAt: '2026-07-29T00:00:00.000Z',
            updatedAt: '2026-07-29T00:00:00.000Z',
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = new BackendApiClient('https://api.example');
        await client.getWatch(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'secret-token',
        );

        expect(String(fetchMock.mock.calls[0][0])).toBe(
            'https://api.example/api/watches/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        );
        expect((fetchMock.mock.calls[0][1]?.headers as Headers).get('authorization'))
            .toBe('Bearer secret-token');
    });

    it('requests every watched sequencer in one revalidatable call', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response('{"cases":[]}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = new BackendApiClient('https://api.example');
        await client.getSequencerCases([
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
        ]);
        expect(String(fetchMock.mock.calls[0][0])).toBe(
            'https://api.example/api/sequencers?addresses=' +
                '0x1111111111111111111111111111111111111111%2C' +
                '0x2222222222222222222222222222222222222222',
        );
    });

    it('opens exact case IDs without an event feed', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = new BackendApiClient('https://api.example');
        await client.getCase('case:mainnet:lineage:address:42');
        expect(String(fetchMock.mock.calls[0][0])).toBe(
            'https://api.example/api/cases/case%3Amainnet%3Alineage%3Aaddress%3A42',
        );
    });
});
