import {
    getAddress,
    type Address,
    type PublicClient,
} from 'viem';
import type { ProtocolSnapshot } from '@shared/protocol/index.ts';
import { rollupAbi } from './contracts/rollupAbi';
import { createCall, multicall } from './multicall';

const STATUS = ['none', 'validating', 'zombie', 'exiting'] as const;

export interface SequencerState {
    sequencer: Address;
    status: typeof STATUS[number];
    effectiveBalance: bigint;
    // Set while stake waits in an exit, after ejection or a voluntary exit.
    exit: SequencerExit | null;
    blockNumber: bigint;
    blockHash: `0x${string}`;
}

export interface SequencerExit {
    amount: bigint;
    exitableAt: bigint;
    // False until the withdrawer of an ejected sequencer names a recipient.
    hasRecipient: boolean;
}

export interface SequencerStateResult {
    states: Map<string, SequencerState>;
    unavailable: string[];
}

export async function readSequencerStates(
    client: PublicClient,
    protocol: Pick<
        ProtocolSnapshot,
        'chainId' | 'blockNumber' | 'blockHash' | 'rollupAddress'
    >,
    addresses: readonly string[],
): Promise<SequencerStateResult> {
    const sequencers = [...new Set(addresses.map((value) =>
        getAddress(value).toLowerCase() as Address))].sort();
    if (sequencers.length === 0) {
        return { states: new Map(), unavailable: [] };
    }

    const blockNumber = BigInt(protocol.blockNumber);
    const expectedBlockHash = protocol.blockHash.toLowerCase() as `0x${string}`;
    const [chainId, before] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockNumber }),
    ]);
    if (chainId !== protocol.chainId) {
        throw new Error(`L1 RPC chain ${chainId} does not match ${protocol.chainId}`);
    }
    assertBlockHash(before.hash, expectedBlockHash, blockNumber);

    const results = await multicall(
        client,
        sequencers.map((sequencer) =>
            createCall(
                getAddress(protocol.rollupAddress),
                rollupAbi,
                'getAttesterView',
                [sequencer],
            )),
        blockNumber,
    );
    const after = await client.getBlock({ blockNumber });
    assertBlockHash(after.hash, expectedBlockHash, blockNumber);

    const states = new Map<string, SequencerState>();
    const unavailable: string[] = [];
    results.forEach((result, index) => {
        const sequencer = sequencers[index];
        if (!result.success) {
            unavailable.push(sequencer);
            return;
        }
        try {
            const view = parseAttesterView(result.data);
            states.set(sequencer, {
                sequencer,
                status: view.status,
                effectiveBalance: view.effectiveBalance,
                exit: view.exit,
                blockNumber,
                blockHash: expectedBlockHash,
            });
        }
        catch {
            unavailable.push(sequencer);
        }
    });
    return { states, unavailable };
}

function parseAttesterView(value: unknown): {
    status: typeof STATUS[number];
    effectiveBalance: bigint;
    exit: SequencerExit | null;
} {
    type ExitView = {
        amount?: unknown;
        exitableAt?: unknown;
        isRecipient?: unknown;
        exists?: unknown;
    };
    const view = value as {
        status?: unknown;
        effectiveBalance?: unknown;
        exit?: ExitView;
        0?: unknown;
        1?: unknown;
        2?: ExitView;
    };
    const statusNumber = Number(view.status ?? view[0]);
    const status = STATUS[statusNumber];
    const effectiveBalance = view.effectiveBalance ?? view[1];
    const exit = view.exit ?? view[2];
    if (!status || typeof effectiveBalance !== 'bigint') {
        throw new Error('getAttesterView returned invalid sequencer state');
    }
    return {
        status,
        effectiveBalance,
        exit: exit?.exists === true &&
            typeof exit.amount === 'bigint' &&
            typeof exit.exitableAt === 'bigint'
            ? {
                amount: exit.amount,
                exitableAt: exit.exitableAt,
                hasRecipient: exit.isRecipient === true,
            }
            : null,
    };
}

function assertBlockHash(
    actual: string | null,
    expected: `0x${string}`,
    blockNumber: bigint,
): void {
    if (!actual || actual.toLowerCase() !== expected) {
        throw new Error(`L1 block ${blockNumber} changed during the sequencer state read`);
    }
}
