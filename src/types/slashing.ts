import type { Address } from 'viem';

export interface MonitorConfigInput {
    l1RpcUrl: string;
    chainId: number;
    registryAddress: Address;
}

export interface DeploymentAddresses {
    resolvedAtBlockNumber: bigint;
    resolvedAtTimestamp: bigint;
    rollupAddress: Address;
    slasherAddress: Address;
    slashingProposerAddress: Address;
    rollupVersion: bigint;
    pendingSlasherAddress: Address;
    pendingSlashingProposerAddress: Address;
    pendingSlasherReadyAt: bigint;
    legacySlasherAddress: Address;
    legacySlashingProposerAddress: Address;
    legacySlasherAuthorizedUntil: bigint;
}

export type RuntimeMonitorConfig = MonitorConfigInput & DeploymentAddresses;

export interface SlashingContractParameters {
    slashingRoundSize: number;
    slashingRoundSizeInEpochs: number;
    executionDelayInRounds: number;
    lifetimeInRounds: number;
    slashOffsetInRounds: number;
    quorum: number;
    committeeSize: number;
    slotDuration: number;
    epochDuration: number;
    l1GenesisTime: bigint;
    // Explanatory values; null when the deployment does not expose them.
    slashAmounts: bigint[] | null;
    staking: {
        activationThreshold: bigint;
        localEjectionThreshold: bigint;
        exitDelay: bigint;
    } | null;
}

export type ResolvedMonitorConfig = RuntimeMonitorConfig & SlashingContractParameters;

export interface CurrentChainState {
    l1BlockNumber: bigint;
    l1BlockHash: `0x${string}`;
    l1Timestamp: bigint;
    currentRound: bigint;
    currentSlot: bigint;
    currentEpoch: bigint;
    isSlashingEnabled: boolean;
    slashingDisabledUntil: bigint;
    slashingDisableDuration: bigint;
    pauseStartedAtSlot: bigint | null;
    pauseEndsAtSlot: bigint | null;
}

export interface SlashAction {
    validator: Address;
    slashAmount: bigint;
}

export interface RoundInfo {
    round: bigint;
    ballotCount: bigint;
    isExecuted: boolean;
}
export type RoundStatus = 'below-quorum' | 'quorum-reached' | 'newly-executable' | 'executable' | 'executed' | 'expired';
export type VerificationStatus = 'verified' | 'partial';
export interface DetectedSlashing {
    round: bigint; // The voting round (payload/committees indexed by this number on-chain)
    status: RoundStatus;
    ballotCount: bigint;
    isExecuted: boolean;
    isVetoed: boolean;
    verificationStatus: VerificationStatus;
    issues?: string[];
    committees?: Address[][];
    targetDetails?: SlashingTargetDetail[];
    slashActions?: SlashAction[];
    payloadAddress?: Address;
    slotWhenExecutable?: bigint;
    slotWhenExpires?: bigint;
    secondsUntilExecutable?: number;
    secondsUntilExpires?: number;
    lastUpdatedTimestamp?: number;
    targetEpochs?: bigint[]; // Epochs from the target round (for reference)
    totalSlashAmount?: bigint;
    affectedValidatorCount?: number;
}

export interface SlashingTargetDetail {
    sequencer: Address;
    epochIndex: number;
    committeeIndex: number;
    targetEpoch: bigint;
    voteCount: number;
    support: number;
    maxSlashUnits: number;
    unitVoteCounts: [number, number, number];
    slashUnits?: number;
    amount?: bigint;
    escaped?: boolean;
    actionIndex?: number;
}

export interface ConfirmedSlash {
    sequencer: Address;
    targetEpoch: bigint;
    round: bigint;
    amount: bigint;
    actionIndex: number;
    transactionHash: `0x${string}`;
    blockNumber: bigint;
    blockHash: `0x${string}`;
    ejected: boolean;
    attesterStatus: number;
    // Seconds; null when the block could not be read.
    blockTimestamp: bigint | null;
    // The stake left right after the slash block, when it could be read.
    stakeAfter: bigint | null;
}

export interface ConfirmedExecution {
    round: bigint;
    slashCount: bigint;
    transactionHash: `0x${string}`;
    blockNumber: bigint;
    blockHash: `0x${string}`;
}

export interface ExecutionHistoryScan {
    status: 'idle' | 'scanning' | 'complete' | 'paused';
    targetFromBlock: bigint | null;
    headBlock: bigint | null;
    oldestScannedBlock: bigint | null;
    scannedBlocks: bigint;
    totalBlocks: bigint;
    chunkSize: bigint;
    lastError: string | null;
}

export interface MonitorIssue {
    source: 'l1-rpc' | 'deployment';
    scope: 'deployment' | 'chain-state' | 'rounds' | 'round-details' | 'execution-history';
    severity?: 'warning' | 'error';
    message: string;
    round?: bigint;
}

export interface MonitorAudit {
    status: 'ok' | 'partial' | 'stale' | 'fatal';
    issues: MonitorIssue[];
    updatedAt: number | null;
    lastSuccessfulAt: number | null;
}

export interface MonitorSnapshot extends CurrentChainState {
    detectedSlashings: Map<bigint, DetectedSlashing>;
    confirmedExecutions: ConfirmedExecution[];
    confirmedSlashes: ConfirmedSlash[];
    executionScan: ExecutionHistoryScan;
    audit: MonitorAudit;
}
