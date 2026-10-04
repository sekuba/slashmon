import {
    createPublicClient,
    decodeEventLog,
    parseAbiItem,
    zeroAddress,
    type Address,
    type PublicClient,
} from 'viem';
import type {
    ConfirmedExecution,
    ConfirmedSlash,
    CurrentChainState,
    DetectedSlashing,
    ExecutionHistoryScan,
    RoundInfo,
    RuntimeMonitorConfig,
    SlashAction,
    SlashingContractParameters,
} from '@/types/slashing';
import { slashingProposerAbi } from './contracts/slashingProposerAbi';
import { rollupAbi } from './contracts/rollupAbi';
import { slasherAbi } from './contracts/slasherAbi';
import { escapeHatchAbi } from './contracts/escapeHatchAbi';
import { assertFreshL1Head, deploymentsMatch, resolveDeploymentWithClient } from './deployment';
import { createCall, multicall, type MulticallResult } from './multicall';
import { createPublicRpcTransport } from './rpc';
import { toErrorMessage } from './errors';

const roundExecutedEvent = parseAbiItem(
    'event RoundExecuted(uint256 indexed round, uint256 slashCount)',
);
const INITIAL_EXECUTION_CHUNK = 1_024n;
const MIN_EXECUTION_CHUNK = 128n;
const MAX_EXECUTION_CHUNK = 5_000n;
const EXECUTION_SCAN_REORG_OVERLAP = 12n;

interface ExecutionHistoryCursor {
    headBlock: bigint;
    targetFromBlock: bigint;
    nextHistoricalToBlock: bigint;
    oldestScannedBlock: bigint | null;
    forwardScannedToBlock: bigint | null;
}

interface ExecutionRange {
    kind: 'history' | 'forward';
    fromBlock: bigint;
    toBlock: bigint;
}

interface ExecutionEvent {
    round: bigint;
    slashCount: bigint;
    transactionHash: `0x${string}`;
    blockNumber: bigint;
    blockHash: `0x${string}`;
}

type AdaptiveRangeResult =
    | {
        ok: true;
        range: ExecutionRange;
        events: ExecutionEvent[];
        rpcCalls: number;
    }
    | {
        ok: false;
        error: string;
        rpcCalls: number;
    };

type ReceiptInspectionResult =
    | { ok: true; rpcCalls: number }
    | { ok: false; error: string; rpcCalls: number };

export interface ExecutionHistoryScanResult {
    confirmedExecutions: ConfirmedExecution[];
    confirmedSlashes: ConfirmedSlash[];
    scan: ExecutionHistoryScan;
    canContinue: boolean;
    rpcCalls: number;
}

export class L1Monitor {
    private readonly publicClient: PublicClient;
    private readonly config: RuntimeMonitorConfig;
    private snapshotBlockNumber?: bigint;
    private snapshotTimestamp?: bigint;
    private executionHistory?: ExecutionHistoryCursor;
    private executionChunkSize = INITIAL_EXECUTION_CHUNK;
    private failedChunkCeiling?: bigint;
    private executionEventCache = new Map<string, ExecutionEvent>();
    private confirmedExecutionCache = new Map<string, ConfirmedExecution>();
    private confirmedSlashCache = new Map<string, ConfirmedSlash>();

    constructor(config: RuntimeMonitorConfig, publicClient?: PublicClient) {
        this.config = config;
        this.publicClient = publicClient ?? createPublicClient({
            transport: createPublicRpcTransport(config.l1RpcUrl),
        });
        this.snapshotBlockNumber = config.resolvedAtBlockNumber;
        this.snapshotTimestamp = config.resolvedAtTimestamp;
    }

    async hasDeploymentChanged(): Promise<boolean> {
        this.snapshotBlockNumber = undefined;
        this.snapshotTimestamp = undefined;
        const currentDeployment = await resolveDeploymentWithClient(
            this.publicClient,
            this.config.registryAddress,
            this.config.chainId
        );
        this.snapshotBlockNumber = currentDeployment.resolvedAtBlockNumber;
        this.snapshotTimestamp = currentDeployment.resolvedAtTimestamp;
        return !deploymentsMatch(this.config, currentDeployment);
    }

    async getCurrentState(): Promise<CurrentChainState> {
        let blockNumber = this.snapshotBlockNumber;
        let timestamp = this.snapshotTimestamp;
        if (blockNumber === undefined || timestamp === undefined) {
            const block = await this.publicClient.getBlock({ blockTag: 'latest' });
            blockNumber = block.number;
            timestamp = block.timestamp;
            this.snapshotBlockNumber = blockNumber;
            this.snapshotTimestamp = timestamp;
        }
        const pinnedBlock = await this.publicClient.getBlock({ blockNumber });
        if (!pinnedBlock.hash) throw new Error(`L1 block ${blockNumber} has no hash`);
        timestamp = pinnedBlock.timestamp;
        this.snapshotTimestamp = timestamp;
        assertFreshL1Head(timestamp);
        const results = await multicall(this.publicClient, [
                createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'getCurrentRound'),
                createCall(this.config.rollupAddress, rollupAbi, 'getCurrentSlot'),
                createCall(this.config.rollupAddress, rollupAbi, 'getCurrentEpoch'),
                createCall(this.config.slasherAddress, slasherAbi, 'isSlashingEnabled'),
                createCall(this.config.slasherAddress, slasherAbi, 'slashingDisabledUntil'),
                createCall(this.config.slasherAddress, slasherAbi, 'SLASHING_DISABLE_DURATION'),
            ], blockNumber);

        const isSlashingEnabled = requireResult<boolean>(results[3], 'isSlashingEnabled');
        const slashingDisabledUntil = requireResult<bigint>(results[4], 'slashingDisabledUntil');
        const slashingDisableDuration = requireResult<bigint>(results[5], 'SLASHING_DISABLE_DURATION');
        let pauseStartedAtSlot: bigint | null = null;
        let pauseEndsAtSlot: bigint | null = null;

        if (!isSlashingEnabled && slashingDisabledUntil > 0n) {
            const pauseStartedAt = slashingDisabledUntil - slashingDisableDuration;
            const pauseSlots = await multicall(this.publicClient, [
                createCall(this.config.rollupAddress, rollupAbi, 'getSlotAt', [pauseStartedAt]),
                createCall(this.config.rollupAddress, rollupAbi, 'getSlotAt', [slashingDisabledUntil]),
            ], blockNumber);
            pauseStartedAtSlot = requireResult(pauseSlots[0], 'getSlotAt(pause start)');
            pauseEndsAtSlot = requireResult(pauseSlots[1], 'getSlotAt(pause end)');
        }

        return {
            l1BlockNumber: blockNumber,
            l1BlockHash: pinnedBlock.hash,
            l1Timestamp: timestamp,
            currentRound: requireResult(results[0], 'getCurrentRound'),
            currentSlot: requireResult(results[1], 'getCurrentSlot'),
            currentEpoch: requireResult(results[2], 'getCurrentEpoch'),
            isSlashingEnabled,
            slashingDisabledUntil,
            slashingDisableDuration,
            pauseStartedAtSlot,
            pauseEndsAtSlot,
        };
    }

    async getRounds(rounds: bigint[]): Promise<Map<bigint, MulticallResult<RoundInfo>>> {
        const results = new Map<bigint, MulticallResult<RoundInfo>>();
        if (rounds.length === 0) {
            return results;
        }

        const fetchedResults = await multicall(
            this.publicClient,
            rounds.map((round) =>
                createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'getRound', [round])
            ),
            this.snapshotBlockNumber
        );

        fetchedResults.forEach((result, index) => {
            const round = rounds[index];

            if (!result.success) {
                results.set(round, result);
                return;
            }

            const [isExecuted, ballotCount] = result.data as [boolean, bigint];
            const roundInfo: RoundInfo = {
                round,
                isExecuted,
                ballotCount,
            };

            results.set(round, { success: true, data: roundInfo });
        });

        return results;
    }

    async batchGetSlashTargetCommittees(rounds: bigint[]): Promise<MulticallResult<Address[][]>[]> {
        if (rounds.length === 0) {
            return [];
        }

        const results = await multicall(
            this.publicClient,
            rounds.map((round) =>
                createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'getSlashTargetCommittees', [round])
            ),
            this.snapshotBlockNumber
        );

        return results.map((result) => {
            if (!result.success) {
                return result;
            }

            return {
                success: true,
                data: result.data as Address[][],
            };
        });
    }

    async batchGetTally(roundsWithCommittees: Array<{ round: bigint; committees: Address[][] }>): Promise<MulticallResult<SlashAction[]>[]> {
        if (roundsWithCommittees.length === 0) {
            return [];
        }

        const results = await multicall(
            this.publicClient,
            roundsWithCommittees.map(({ round, committees }) =>
                createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'getTally', [round, committees])
            ),
            this.snapshotBlockNumber
        );

        return results.map((result) => {
            if (!result.success) {
                return result;
            }

            return {
                success: true,
                data: mapSlashActions(result.data as Array<{ validator: Address; slashAmount: bigint }>),
            };
        });
    }

    async getVotes(round: bigint, ballotCount: bigint): Promise<string[]> {
        if (ballotCount > 1_024n) {
            throw new Error(`Round ${round} has an implausible ballot count`);
        }
        const calls = Array.from({ length: Number(ballotCount) }, (_, index) =>
            createCall(
                this.config.slashingProposerAddress,
                slashingProposerAbi,
                'getVotes',
                [round, BigInt(index)],
            ));
        const results = await multicall(this.publicClient, calls, this.snapshotBlockNumber);
        return results.map((result, index) =>
            requireResult<string>(result, `getVotes(${round}, ${index})`));
    }

    async getEscapeHatchFlags(targetEpochs: bigint[]): Promise<boolean[]> {
        const hatchResults = await multicall(
            this.publicClient,
            targetEpochs.map((epoch) =>
                createCall(
                    this.config.rollupAddress,
                    rollupAbi,
                    'getEscapeHatchForEpoch',
                    [epoch],
                )),
            this.snapshotBlockNumber,
        );
        const hatches = hatchResults.map((result, index) =>
            requireResult<Address>(result, `getEscapeHatchForEpoch(${targetEpochs[index]})`));
        const openCalls = hatches.flatMap((hatch, index) =>
            hatch === zeroAddress
                ? []
                : [{
                    index,
                    call: createCall(hatch, escapeHatchAbi, 'isHatchOpen', [targetEpochs[index]]),
                }]);
        const openResults = await multicall(
            this.publicClient,
            openCalls.map((item) => item.call),
            this.snapshotBlockNumber,
        );
        const flags = hatches.map(() => false);
        openResults.forEach((result, resultIndex) => {
            const [isOpen] = requireResult<readonly [boolean, Address]>(
                result,
                `isHatchOpen(${targetEpochs[openCalls[resultIndex].index]})`,
            );
            flags[openCalls[resultIndex].index] = isOpen;
        });
        return flags;
    }

    async batchGetPayloadAddressesAndVetoStatus(roundsWithActions: Array<{ round: bigint; actions: SlashAction[] }>): Promise<MulticallResult<{
        payloadAddress: Address;
        isVetoed: boolean;
    }>[]> {
        if (roundsWithActions.length === 0) {
            return [];
        }

        const payloadResults = await multicall(
            this.publicClient,
            roundsWithActions.map(({ round, actions }) =>
                createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'getPayloadAddress', [round, actions])
            ),
            this.snapshotBlockNumber
        );

        const vetoInputs: Address[] = [];
        const vetoResultIndexByRound = new Map<number, number>();

        payloadResults.forEach((result, index) => {
            if (!result.success) {
                return;
            }

            vetoResultIndexByRound.set(index, vetoInputs.length);
            vetoInputs.push(result.data as Address);
        });

        const vetoResults = vetoInputs.length === 0
            ? []
            : await multicall(
                this.publicClient,
                vetoInputs.map((address) =>
                    createCall(this.config.slasherAddress, slasherAbi, 'vetoedPayloads', [address])
                ),
                this.snapshotBlockNumber
            );

        return payloadResults.map((payloadResult, index) => {
            if (!payloadResult.success) {
                return payloadResult;
            }

            const vetoResult = vetoResults[vetoResultIndexByRound.get(index) ?? -1];
            if (!vetoResult || !vetoResult.success) {
                return {
                    success: false,
                    error: vetoResult?.error ?? new Error(`Missing veto status for round ${roundsWithActions[index].round}`),
                };
            }

            return {
                success: true,
                data: {
                    payloadAddress: payloadResult.data as Address,
                    isVetoed: vetoResult.data as boolean,
                },
            };
        });
    }

    async scanExecutionHistory(
        detected: readonly DetectedSlashing[],
        lookbackBlocks: bigint,
    ): Promise<ExecutionHistoryScanResult> {
        const executed = detected.filter((item) =>
            item.isExecuted && (item.targetDetails?.length ?? 0) > 0);
        if (this.snapshotBlockNumber === undefined) {
            return this.executionResult(detected, idleExecutionScan(), false, 0);
        }
        if (executed.length === 0 && !this.executionHistory) {
            return this.executionResult(detected, idleExecutionScan(), false, 0);
        }
        const toBlock = this.snapshotBlockNumber;
        const executedByRound = new Map(executed.map((item) => [item.round, item]));
        this.ensureExecutionHistory(toBlock, lookbackBlocks);

        if (executed.length === 0) {
            this.executionHistory!.oldestScannedBlock =
                this.executionHistory!.targetFromBlock;
            this.executionHistory!.nextHistoricalToBlock =
                this.executionHistory!.targetFromBlock - 1n;
            this.executionHistory!.forwardScannedToBlock = toBlock;
            return this.executionResult(
                detected,
                this.executionProgress('complete', null),
                false,
                0,
            );
        }

        const pendingReceipt = this.pendingExecutionEvent(executedByRound);
        if (pendingReceipt) {
            const inspected = await this.inspectExecutionEvent(
                pendingReceipt,
                executedByRound.get(pendingReceipt.round)!,
                toBlock,
            );
            if (!inspected.ok) {
                return this.executionResult(
                    detected,
                    this.executionProgress('paused', inspected.error),
                    false,
                    inspected.rpcCalls,
                );
            }
            const moreReceipts = this.pendingExecutionEvent(executedByRound) !==
                undefined;
            const complete = this.executionHistoryComplete() && !moreReceipts;
            return this.executionResult(
                detected,
                this.executionProgress(complete ? 'complete' : 'scanning', null),
                !complete,
                inspected.rpcCalls,
            );
        }

        const range = this.nextExecutionRange(toBlock);
        if (!range) {
            return this.executionResult(
                detected,
                this.executionProgress('complete', null),
                false,
                0,
            );
        }

        const scanned = await this.scanAdaptiveRange(range);
        if (!scanned.ok) {
            return this.executionResult(
                detected,
                this.executionProgress('paused', scanned.error),
                false,
                scanned.rpcCalls,
            );
        }

        this.commitExecutionRange(scanned.range, scanned.events);
        const event = scanned.events.find((candidate) =>
            executedByRound.has(candidate.round) &&
            !this.confirmedExecutionCache.has(executionEventKey(candidate)));
        if (event) {
            const inspected = await this.inspectExecutionEvent(
                event,
                executedByRound.get(event.round)!,
                toBlock,
            );
            scanned.rpcCalls += inspected.rpcCalls;
            if (!inspected.ok) {
                return this.executionResult(
                    detected,
                    this.executionProgress('paused', inspected.error),
                    false,
                    scanned.rpcCalls,
                );
            }
        }

        const moreReceipts = this.pendingExecutionEvent(executedByRound) !==
            undefined;
        const complete = this.executionHistoryComplete() && !moreReceipts;
        return this.executionResult(
            detected,
            this.executionProgress(complete ? 'complete' : 'scanning', null),
            !complete,
            scanned.rpcCalls,
        );
    }

    async loadContractParameters(): Promise<SlashingContractParameters> {
        const results = await multicall(this.publicClient, [
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'QUORUM'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'ROUND_SIZE'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'ROUND_SIZE_IN_EPOCHS'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'EXECUTION_DELAY_IN_ROUNDS'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'LIFETIME_IN_ROUNDS'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'SLASH_OFFSET_IN_ROUNDS'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'COMMITTEE_SIZE'),
            createCall(this.config.rollupAddress, rollupAbi, 'getSlotDuration'),
            createCall(this.config.rollupAddress, rollupAbi, 'getEpochDuration'),
            createCall(this.config.rollupAddress, rollupAbi, 'getGenesisTime'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'SLASH_AMOUNT_SMALL'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'SLASH_AMOUNT_MEDIUM'),
            createCall(this.config.slashingProposerAddress, slashingProposerAbi, 'SLASH_AMOUNT_LARGE'),
            createCall(this.config.rollupAddress, rollupAbi, 'getActivationThreshold'),
            createCall(this.config.rollupAddress, rollupAbi, 'getLocalEjectionThreshold'),
            createCall(this.config.rollupAddress, rollupAbi, 'getExitDelay'),
        ], this.snapshotBlockNumber);
        const slashAmounts = optionalBigInts(results.slice(10, 13));
        const staking = optionalBigInts(results.slice(13, 16));

        return {
            quorum: Number(requireResult(results[0], 'QUORUM')),
            slashingRoundSize: Number(requireResult(results[1], 'ROUND_SIZE')),
            slashingRoundSizeInEpochs: Number(requireResult(results[2], 'ROUND_SIZE_IN_EPOCHS')),
            executionDelayInRounds: Number(requireResult(results[3], 'EXECUTION_DELAY_IN_ROUNDS')),
            lifetimeInRounds: Number(requireResult(results[4], 'LIFETIME_IN_ROUNDS')),
            slashOffsetInRounds: Number(requireResult(results[5], 'SLASH_OFFSET_IN_ROUNDS')),
            committeeSize: Number(requireResult(results[6], 'COMMITTEE_SIZE')),
            slotDuration: Number(requireResult(results[7], 'getSlotDuration')),
            epochDuration: Number(requireResult(results[8], 'getEpochDuration')),
            l1GenesisTime: requireResult(results[9], 'getGenesisTime'),
            slashAmounts,
            staking: staking && {
                activationThreshold: staking[0],
                localEjectionThreshold: staking[1],
                exitDelay: staking[2],
            },
        };
    }

    private ensureExecutionHistory(toBlock: bigint, lookbackBlocks: bigint) {
        if (!this.executionHistory) {
            this.executionHistory = {
                headBlock: toBlock,
                targetFromBlock: executionScanFromBlock(toBlock, lookbackBlocks),
                nextHistoricalToBlock: toBlock,
                oldestScannedBlock: null,
                forwardScannedToBlock: null,
            };
            return;
        }
        const forwardHead = this.executionHistory.forwardScannedToBlock;
        if (
            forwardHead !== null &&
            toBlock > forwardHead + MAX_EXECUTION_CHUNK
        ) {
            this.executionEventCache.clear();
            this.confirmedExecutionCache.clear();
            this.confirmedSlashCache.clear();
            this.executionHistory = {
                headBlock: toBlock,
                targetFromBlock: executionScanFromBlock(toBlock, lookbackBlocks),
                nextHistoricalToBlock: toBlock,
                oldestScannedBlock: null,
                forwardScannedToBlock: null,
            };
            return;
        }
        if (
            forwardHead === null &&
            this.executionHistory.oldestScannedBlock === null
        ) {
            this.executionHistory.targetFromBlock =
                executionScanFromBlock(toBlock, lookbackBlocks);
            this.executionHistory.nextHistoricalToBlock = toBlock;
        }
        this.executionHistory.headBlock = toBlock;
    }

    private nextExecutionRange(toBlock: bigint): ExecutionRange | null {
        const history = this.executionHistory!;
        if (
            history.forwardScannedToBlock !== null &&
            toBlock > history.forwardScannedToBlock
        ) {
            const fromBlock = history.forwardScannedToBlock >
                    EXECUTION_SCAN_REORG_OVERLAP
                ? history.forwardScannedToBlock - EXECUTION_SCAN_REORG_OVERLAP
                : 0n;
            return { kind: 'forward', fromBlock, toBlock };
        }
        if (history.nextHistoricalToBlock < history.targetFromBlock) return null;
        const available = history.nextHistoricalToBlock -
            history.targetFromBlock + 1n;
        const size = minBigInt(this.executionChunkSize, available);
        return {
            kind: 'history',
            fromBlock: history.nextHistoricalToBlock - size + 1n,
            toBlock: history.nextHistoricalToBlock,
        };
    }

    private async scanAdaptiveRange(
        initialRange: ExecutionRange,
    ): Promise<AdaptiveRangeResult> {
        let range = initialRange;
        let rpcCalls = 0;
        for (;;) {
            const startedAt = Date.now();
            try {
                const logs = await this.publicClient.getLogs({
                    address: this.config.slashingProposerAddress,
                    event: roundExecutedEvent,
                    fromBlock: range.fromBlock,
                    toBlock: range.toBlock,
                    strict: true,
                });
                rpcCalls += 1;
                const elapsed = Date.now() - startedAt;
                this.tuneExecutionChunk(range, elapsed);
                return {
                    ok: true,
                    range,
                    events: logs.map((log) => ({
                        round: log.args.round,
                        slashCount: log.args.slashCount,
                        transactionHash: log.transactionHash,
                        blockNumber: log.blockNumber,
                        blockHash: log.blockHash,
                    })),
                    rpcCalls,
                };
            }
            catch (error) {
                rpcCalls += 1;
                const message = toErrorMessage(error);
                const size = range.toBlock - range.fromBlock + 1n;
                if (
                    range.kind !== 'history' ||
                    isRateLimitError(message) ||
                    !isRangeCapacityError(message) ||
                    size <= MIN_EXECUTION_CHUNK
                ) {
                    return { ok: false, error: message, rpcCalls };
                }
                this.failedChunkCeiling = this.failedChunkCeiling === undefined
                    ? size
                    : minBigInt(this.failedChunkCeiling, size);
                this.executionChunkSize = maxBigInt(
                    MIN_EXECUTION_CHUNK,
                    size / 2n,
                );
                range = {
                    ...range,
                    fromBlock: range.toBlock - this.executionChunkSize + 1n,
                };
            }
        }
    }

    private tuneExecutionChunk(range: ExecutionRange, elapsedMs: number) {
        if (range.kind !== 'history') return;
        const size = range.toBlock - range.fromBlock + 1n;
        if (elapsedMs > 4_000) {
            this.executionChunkSize = maxBigInt(
                MIN_EXECUTION_CHUNK,
                size / 2n,
            );
            return;
        }
        if (elapsedMs > 1_500) {
            this.executionChunkSize = size;
            return;
        }
        const grown = minBigInt(MAX_EXECUTION_CHUNK, size * 2n);
        this.executionChunkSize = this.failedChunkCeiling !== undefined &&
                grown >= this.failedChunkCeiling
            ? size
            : grown;
    }

    private commitExecutionRange(
        range: ExecutionRange,
        events: readonly ExecutionEvent[],
    ) {
        const history = this.executionHistory!;
        if (range.kind === 'forward') {
            for (const [key, event] of this.executionEventCache) {
                if (event.blockNumber >= range.fromBlock) {
                    this.executionEventCache.delete(key);
                }
            }
            for (const [key, execution] of this.confirmedExecutionCache) {
                if (execution.blockNumber >= range.fromBlock) {
                    this.confirmedExecutionCache.delete(key);
                }
            }
            for (const [key, slash] of this.confirmedSlashCache) {
                if (slash.blockNumber >= range.fromBlock) {
                    this.confirmedSlashCache.delete(key);
                }
            }
            history.forwardScannedToBlock = range.toBlock;
        }
        else {
            history.oldestScannedBlock = range.fromBlock;
            history.nextHistoricalToBlock = range.fromBlock - 1n;
            history.forwardScannedToBlock ??= history.headBlock;
        }
        for (const event of events) {
            this.executionEventCache.set(executionEventKey(event), event);
        }
    }

    private pendingExecutionEvent(
        executedByRound: ReadonlyMap<bigint, DetectedSlashing>,
    ): ExecutionEvent | undefined {
        return [...this.executionEventCache.values()].find((event) =>
            executedByRound.has(event.round) &&
            !this.confirmedExecutionCache.has(executionEventKey(event)));
    }

    private async inspectExecutionEvent(
        event: ExecutionEvent,
        item: DetectedSlashing,
        blockNumber: bigint,
    ): Promise<ReceiptInspectionResult> {
        let rpcCalls = 0;
        try {
            const receipt = await this.publicClient.getTransactionReceipt({
                hash: event.transactionHash,
            });
            rpcCalls += 1;
            const slashLogs = decodeExactReceiptSlashes(
                item,
                receipt.logs,
                this.config.rollupAddress,
            );
            if (slashLogs.length > 0) rpcCalls += 1;
            const statusResults = await multicall(
                this.publicClient,
                slashLogs.map((slash) =>
                    createCall(
                        this.config.rollupAddress,
                        rollupAbi,
                        'getStatus',
                        [slash.sequencer],
                    )),
                blockNumber,
            );
            // The stake right after the slash needs state at its block, which
            // a public RPC without archive state cannot serve; it is optional.
            const views = slashLogs.length === 0
                ? []
                : await multicall(
                    this.publicClient,
                    slashLogs.map((slash) =>
                        createCall(
                            this.config.rollupAddress,
                            rollupAbi,
                            'getAttesterView',
                            [slash.sequencer],
                        )),
                    event.blockNumber,
                ).catch(() => []);
            if (slashLogs.length > 0) rpcCalls += 1;
            // The block time dates the slash; without it the slash still counts.
            const blockTimestamp = slashLogs.length === 0
                ? null
                : await this.publicClient.getBlock({ blockNumber: event.blockNumber }).then(
                    (block) => block.hash?.toLowerCase() === event.blockHash.toLowerCase()
                        ? block.timestamp
                        : null,
                    () => null,
                );
            if (slashLogs.length > 0) rpcCalls += 1;
            const nextSlashes = slashLogs.map((slash, index) => {
                const status = Number(requireResult(
                    statusResults[index],
                    'getStatus',
                ));
                const view = views[index];
                return {
                    sequencer: slash.sequencer,
                    targetEpoch: slash.targetEpoch,
                    round: item.round,
                    amount: slash.amount,
                    actionIndex: slash.actionIndex,
                    transactionHash: event.transactionHash,
                    blockNumber: event.blockNumber,
                    blockHash: event.blockHash,
                    ejected: status === 2 || status === 3,
                    attesterStatus: status,
                    blockTimestamp,
                    stakeAfter: view?.success ? stakeFromAttesterView(view.data) : null,
                } satisfies ConfirmedSlash;
            });
            this.confirmedExecutionCache.set(executionEventKey(event), {
                round: event.round,
                slashCount: event.slashCount,
                transactionHash: event.transactionHash,
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
            });
            for (const slash of nextSlashes) {
                this.confirmedSlashCache.set(confirmedSlashKey(slash), slash);
            }
            return {
                ok: true,
                rpcCalls,
            };
        }
        catch (error) {
            return {
                ok: false,
                error: toErrorMessage(error),
                rpcCalls: Math.max(1, rpcCalls),
            };
        }
    }

    private executionHistoryComplete(): boolean {
        const history = this.executionHistory!;
        return history.nextHistoricalToBlock < history.targetFromBlock;
    }

    private executionProgress(
        status: ExecutionHistoryScan['status'],
        lastError: string | null,
    ): ExecutionHistoryScan {
        const history = this.executionHistory!;
        const totalBlocks = history.headBlock - history.targetFromBlock + 1n;
        const scannedBlocks = history.oldestScannedBlock === null
            ? 0n
            : history.headBlock - history.oldestScannedBlock + 1n;
        return {
            status,
            targetFromBlock: history.targetFromBlock,
            headBlock: history.headBlock,
            oldestScannedBlock: history.oldestScannedBlock,
            scannedBlocks: minBigInt(scannedBlocks, totalBlocks),
            totalBlocks,
            chunkSize: this.executionChunkSize,
            lastError,
        };
    }

    private executionResult(
        detected: readonly DetectedSlashing[],
        scan: ExecutionHistoryScan,
        canContinue: boolean,
        rpcCalls: number,
    ): ExecutionHistoryScanResult {
        const rounds = new Set(
            detected.filter((item) => item.isExecuted).map((item) => item.round),
        );
        return {
            confirmedExecutions: [...this.confirmedExecutionCache.values()]
                .filter((item) => rounds.has(item.round)),
            confirmedSlashes: [...this.confirmedSlashCache.values()]
                .filter((item) => rounds.has(item.round)),
            scan,
            canContinue,
            rpcCalls,
        };
    }
}

function requireResult<T>(result: MulticallResult, label: string): T {
    if (!result.success) {
        throw new Error(`${label} failed: ${result.error.message}`);
    }

    return result.data as T;
}

// A validating attester's stake is its effective balance; an ejected or
// exiting one's is the amount waiting in its exit.
function stakeFromAttesterView(value: unknown): bigint | null {
    const view = value as {
        status?: unknown;
        effectiveBalance?: unknown;
        exit?: { amount?: unknown; exists?: unknown };
    } | null;
    const status = Number(view?.status);
    if (status === 1 && typeof view?.effectiveBalance === 'bigint') return view.effectiveBalance;
    if (
        (status === 2 || status === 3) &&
        view?.exit?.exists === true &&
        typeof view.exit.amount === 'bigint'
    ) {
        return view.exit.amount;
    }
    return status === 0 ? 0n : null;
}

// Stake rules explain an outcome but do not decide one: a deployment without
// these getters shows no stake rules instead of failing the Monitor.
function optionalBigInts(results: readonly MulticallResult[]): bigint[] | null {
    const values = results.map((result) =>
        result.success && typeof result.data === 'bigint' ? result.data : null);
    return values.every((value) => value !== null) ? values as bigint[] : null;
}

function mapSlashActions(actions: Array<{ validator: Address; slashAmount: bigint }>): SlashAction[] {
    return actions.map((action) => ({
        validator: action.validator,
        slashAmount: action.slashAmount,
    }));
}

export function executionScanFromBlock(
    toBlock: bigint,
    lookbackBlocks: bigint,
): bigint {
    return toBlock > lookbackBlocks ? toBlock - lookbackBlocks : 0n;
}

function confirmedSlashKey(slash: ConfirmedSlash): string {
    return [
        slash.blockHash,
        slash.transactionHash,
        slash.actionIndex,
    ].join(':');
}

function executionEventKey(event: Pick<
    ExecutionEvent,
    'round' | 'blockHash' | 'transactionHash'
>): string {
    return [
        event.round,
        event.blockHash,
        event.transactionHash,
    ].join(':');
}

function idleExecutionScan(): ExecutionHistoryScan {
    return {
        status: 'idle',
        targetFromBlock: null,
        headBlock: null,
        oldestScannedBlock: null,
        scannedBlocks: 0n,
        totalBlocks: 0n,
        chunkSize: INITIAL_EXECUTION_CHUNK,
        lastError: null,
    };
}

function isRateLimitError(message: string): boolean {
    return /(?:\b429\b|rate.?limit|too many requests|compute units)/i.test(message);
}

function isRangeCapacityError(message: string): boolean {
    return /(?:\b413\b|block range|range limit|query returned more|response size|payload too large|limit exceeded|timed? out|timeout|took too long|deadline exceeded|max(?:imum)?.*range)/i
        .test(message);
}

function minBigInt(left: bigint, right: bigint): bigint {
    return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint): bigint {
    return left > right ? left : right;
}

export function decodeExactReceiptSlashes(
    item: DetectedSlashing,
    logs: readonly {
        address: Address;
        data: `0x${string}`;
        topics: [] | [`0x${string}`, ...`0x${string}`[]];
    }[],
    rollupAddress: Address,
): Array<{
    sequencer: Address;
    amount: bigint;
    actionIndex: number;
    targetEpoch: bigint;
}> {
    const slashLogs = logs.flatMap((log) => {
        if (log.address.toLowerCase() !== rollupAddress.toLowerCase()) return [];
        try {
            const decoded = decodeEventLog({
                abi: rollupAbi,
                eventName: 'Slashed',
                data: log.data,
                topics: log.topics,
                strict: true,
            });
            return [{
                sequencer: decoded.args.attester,
                amount: decoded.args.amount,
            }];
        }
        catch {
            return [];
        }
    });
    return slashLogs.map((slash, actionIndex) => {
        const target = item.targetDetails?.find(
            (detail) => detail.actionIndex === actionIndex,
        ) ?? item.targetDetails?.[actionIndex];
        if (
            !target ||
            target.sequencer.toLowerCase() !== slash.sequencer.toLowerCase()
        ) {
            throw new Error(
                `Round ${item.round} receipt does not match its exact action order`,
            );
        }
        return {
            ...slash,
            actionIndex,
            targetEpoch: target.targetEpoch,
        };
    });
}
