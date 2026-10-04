export type Network = 'mainnet' | 'testnet';

export type ObservationSource = 'aztec_sentinel' | 'aztec_node' | 'ethereum_l1';

export type ObservationKind =
    | 'duty_miss'
    | 'inactivity_epoch'
    | 'node_offense'
    | 'l1_round'
    | 'l1_execution'
    | 'l1_slash'
    | 'stake_status';

export type CaseStage =
    | 'precursor'
    | 'node_offense'
    | 'awaiting_round'
    | 'l1_support'
    | 'candidate'
    | 'delayed'
    | 'executable'
    | 'vetoed'
    | 'expired'
    | 'executed'
    | 'stake_removed'
    | 'ejected'
    | 'resolved'
    | 'reorged';

export type CaseUrgency = 'normal' | 'info' | 'warning' | 'critical';
export type TransitionSeverity = 'info' | 'warning' | 'critical';

export interface ObservationProvenance {
    observedAt: string;
    blockNumber?: string;
    blockHash?: string;
    transactionHash?: string;
    // When the block was produced, for evidence whose observedAt is the time
    // it was collected.
    blockTime?: string;
    nodeCursor?: string;
    invalidatedAt?: string;
    canonical: boolean;
}

export interface Observation {
    id: string;
    network: Network;
    source: ObservationSource;
    kind: ObservationKind;
    sequencer: string;
    lineageId: string;
    targetEpoch: string;
    slot?: string;
    round?: string;
    provenance: ObservationProvenance;
    data: Record<string, unknown>;
}

export interface SlashingLineage {
    role: 'active' | 'pending' | 'legacy';
    rollupAddress: string;
    slasherAddress: string;
    proposerAddress: string;
    currentRound: string;
    isSlashingEnabled: boolean;
    disabledUntil: string | null;
    parameters: {
        quorum: number;
        roundSizeSlots: number;
        roundSizeEpochs: number;
        executionDelayRounds: number;
        lifetimeRounds: number;
        slashOffsetRounds: number;
        committeeSize: number;
        // Penalty units 1, 2, and 3, in AZTEC base units. Absent from
        // snapshots taken before these were read.
        slashAmounts?: string[] | null;
    };
}

// Stake rules of the canonical Rollup, in AZTEC base units.
export interface StakingParameters {
    activationThreshold: string;
    // A slash leaving less than this ejects the validator; equality does not.
    localEjectionThreshold: string;
    exitDelaySeconds: number;
}

export interface ProtocolSnapshot {
    network: Network;
    chainId: number;
    observedAt: string;
    blockNumber: string;
    blockHash: string;
    registryAddress: string;
    rollupAddress: string;
    genesisTime: string;
    currentSlot: string;
    currentEpoch: string;
    slotDurationSeconds: number;
    epochDurationSlots: number;
    lineages: SlashingLineage[];
    inactivity: {
        targetPercentage: number;
        consecutiveEpochs: number;
    } | null;
    staking?: StakingParameters | null;
}

export interface CaseReason {
    label: string;
    provenance: 'node_evidence' | 'unknown_on_l1';
    evidenceIds: string[];
}

export interface NextTransition {
    label: string;
    slot: string | null;
    at: string | null;
}

export interface CaseState {
    stage: CaseStage;
    urgency: CaseUrgency;
    headline: string;
    explanation: string;
    reason: CaseReason;
    nextTransition: NextTransition | null;
    requestedAmount: string | null;
    actualAmount: string | null;
    payloadAddress: string | null;
    round: string | null;
    active: boolean;
}

export interface SlashingCase {
    id: string;
    network: Network;
    sequencer: string;
    lineageId: string;
    targetEpoch: string;
    firstObservedAt: string;
    lastObservedAt: string;
    state: CaseState;
    observations: Observation[];
}

export interface CaseTransition {
    id: string;
    caseId: string;
    sequencer: string;
    fromStage: CaseStage | null;
    toStage: CaseStage;
    severity: TransitionSeverity;
    title: string;
    body: string;
    observedAt: string;
}

export interface AddressStatus {
    sequencer: string;
    headline: string;
    urgency: CaseUrgency;
    activeCase: SlashingCase | null;
    cases: SlashingCase[];
}

export interface SourceStatus {
    source: ObservationSource;
    status: 'healthy' | 'stale' | 'unavailable';
    lastSuccessAt: string | null;
    lastError: string | null;
}

export interface NetworkSummary {
    activeCases: number;
    precursors: number;
    nodeOffenses: number;
    l1Supported: number;
    candidates: number;
    executable: number;
    actualSlashes: number;
    ejections: number;
    stakeAtRisk: string;
}
