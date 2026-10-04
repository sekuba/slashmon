import { describe, expect, it } from 'vitest';
import {
    decodeFunctionData,
    encodeFunctionResult,
    zeroAddress,
    type PublicClient,
} from 'viem';
import type { ProtocolSnapshot } from '@shared/protocol/index.ts';
import { rollupAbi } from './contracts/rollupAbi';
import { readSequencerStates } from './sequencerState';

const ROLLUP = '0x1000000000000000000000000000000000000001';
const SEQUENCER_A = '0x2000000000000000000000000000000000000002';
const SEQUENCER_B = '0x3000000000000000000000000000000000000003';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as const;

describe('readSequencerStates', () => {
    it('batches exact pinned-block attester views and preserves zero balances', async () => {
        const client = fakeClient(new Map([
            [SEQUENCER_A, attesterView(1, 197_500n)],
            [SEQUENCER_B, attesterView(3, 0n, 42_000n)],
        ]));

        const result = await readSequencerStates(
            client,
            protocol(),
            [SEQUENCER_B, SEQUENCER_A, SEQUENCER_A],
        );

        expect([...result.states.keys()]).toEqual([SEQUENCER_A, SEQUENCER_B]);
        expect(result.states.get(SEQUENCER_A)).toMatchObject({
            status: 'validating',
            effectiveBalance: 197_500n,
            exit: null,
            blockNumber: 100n,
            blockHash: BLOCK_HASH,
        });
        expect(result.states.get(SEQUENCER_B)).toMatchObject({
            status: 'exiting',
            effectiveBalance: 0n,
            exit: { amount: 42_000n, exitableAt: 0n, hasRecipient: false },
        });
        expect(result.unavailable).toEqual([]);
    });

    it('rejects a pinned block replaced during the balance read', async () => {
        const client = fakeClient(
            new Map([[SEQUENCER_A, attesterView(1, 1n)]]),
            `0x${'cd'.repeat(32)}`,
        );
        await expect(readSequencerStates(
            client,
            protocol(),
            [SEQUENCER_A],
        )).rejects.toThrow('changed during the sequencer state read');
    });
});

function fakeClient(
    views: Map<string, ReturnType<typeof attesterView>>,
    secondBlockHash = BLOCK_HASH,
): PublicClient {
    let blockReads = 0;
    return {
        async getChainId() {
            return 1;
        },
        async getBlock() {
            blockReads += 1;
            return { hash: blockReads === 1 ? BLOCK_HASH : secondBlockHash };
        },
        async readContract({ args, functionName }: {
            args: readonly [readonly {
                target: string;
                allowFailure: boolean;
                callData: `0x${string}`;
            }[]];
            functionName: string;
        }) {
            expect(functionName).toBe('aggregate3');
            return args[0].map((call) => {
                const decoded = decodeFunctionData({
                    abi: rollupAbi,
                    data: call.callData,
                });
                const [sequencer] = decoded.args as readonly [string];
                const view = views.get(sequencer.toLowerCase());
                return view
                    ? {
                        success: true,
                        returnData: encodeFunctionResult({
                            abi: rollupAbi,
                            functionName: 'getAttesterView',
                            result: view,
                        }),
                    }
                    : { success: false, returnData: '0x' };
            });
        },
    } as unknown as PublicClient;
}

function attesterView(status: number, effectiveBalance: bigint, exitAmount?: bigint) {
    return {
        status,
        effectiveBalance,
        exit: {
            withdrawalId: 0n,
            amount: exitAmount ?? 0n,
            exitableAt: 0n,
            recipientOrWithdrawer: zeroAddress,
            isRecipient: false,
            exists: exitAmount !== undefined,
        },
        config: {
            publicKey: { x: 0n, y: 0n },
            withdrawer: zeroAddress,
        },
    };
}

function protocol(): Pick<
    ProtocolSnapshot,
    'chainId' | 'blockNumber' | 'blockHash' | 'rollupAddress'
> {
    return {
        chainId: 1,
        blockNumber: '100',
        blockHash: BLOCK_HASH,
        rollupAddress: ROLLUP,
    };
}
