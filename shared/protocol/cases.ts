import { formatAztec, humanizeOffense } from './format.ts';
import { votingRoundForEpoch } from './lifecycle.ts';
import type {
    AddressStatus,
    CaseReason,
    CaseStage,
    CaseState,
    CaseUrgency,
    NetworkSummary,
    Observation,
    ObservationKind,
    ProtocolSnapshot,
    SlashingCase,
    SlashingLineage,
} from './types.ts';

export const STAGE_RANK: Record<CaseStage, number> = {
    reorged: 0,
    resolved: 1,
    precursor: 2,
    node_offense: 3,
    awaiting_round: 4,
    l1_support: 5,
    candidate: 6,
    delayed: 7,
    vetoed: 8,
    expired: 9,
    executable: 10,
    executed: 11,
    stake_removed: 12,
    ejected: 13,
};

export const URGENCY_RANK: Record<CaseUrgency, number> = {
    normal: 0,
    info: 1,
    warning: 2,
    critical: 3,
};

// A closed case that never reached quorum stays in the public network feed for
// this long after its last evidence. Outcomes that did reach quorum are rare
// and are the monitor's history, so they are kept.
export const CLOSED_CASE_RETENTION_DAYS = 7;
const HOUR_MS = 3_600_000;
export const RETAINED_OUTCOME_STAGES: readonly CaseStage[] = [
    'vetoed',
    'expired',
    'executed',
    'stake_removed',
    'ejected',
];

// The earliest last-evidence time a retained closed case may have. It moves in
// whole hours, so a response built from it stays identical, and cacheable,
// until a case changes or the next hour begins.
export function closedCaseCutoff(now: number): number {
    return Math.floor(now / HOUR_MS) * HOUR_MS -
        CLOSED_CASE_RETENTION_DAYS * 24 * HOUR_MS;
}

export function caseIdFor(observation: Pick<
    Observation,
    'network' | 'lineageId' | 'sequencer' | 'targetEpoch'
>): string {
    return [
        'case',
        observation.network,
        observation.lineageId.toLowerCase(),
        observation.sequencer.toLowerCase(),
        observation.targetEpoch,
    ].join(':');
}

export function projectCases(
    observations: readonly Observation[],
    protocol: ProtocolSnapshot | null,
): SlashingCase[] {
    const grouped = new Map<string, Observation[]>();
    for (const observation of observations) {
        const id = caseIdFor(observation);
        const existing = grouped.get(id);
        if (existing) existing.push(observation);
        else grouped.set(id, [observation]);
    }

    return [...grouped.entries()]
        .map(([id, evidence]) => projectCase(id, evidence, protocol))
        .sort(compareCases);
}

export function projectAddressStatus(
    sequencer: string,
    cases: readonly SlashingCase[],
): AddressStatus {
    const normalized = sequencer.toLowerCase();
    const matching = cases
        .filter((item) => item.sequencer === normalized)
        .sort(compareCases);
    const activeCase = matching.find((item) => item.state.active) ?? null;
    // With nothing open, a confirmed slash outcome still defines the address;
    // a closed case that never slashed does not.
    const headlineCase = activeCase ??
        matching.find((item) => item.state.urgency === 'critical') ??
        null;
    return {
        sequencer: normalized,
        headline: headlineCase?.state.headline ?? (matching.length > 0
            ? 'No open slashing cases'
            : 'No recent slashing evidence'),
        urgency: headlineCase?.state.urgency ?? 'normal',
        activeCase,
        cases: matching,
    };
}

export function summarizeNetwork(
    cases: readonly SlashingCase[],
): NetworkSummary {
    let stakeAtRisk = 0n;
    for (const item of cases) {
        if (item.state.active && item.state.requestedAmount) {
            stakeAtRisk += BigInt(item.state.requestedAmount);
        }
    }
    // Pipeline stages count open cases; a closed veto is no candidate.
    const open = cases.filter((item) => item.state.active);
    return {
        activeCases: open.length,
        precursors: open.filter((item) => item.state.stage === 'precursor').length,
        nodeOffenses: open.filter((item) =>
            ['node_offense', 'awaiting_round'].includes(item.state.stage)).length,
        l1Supported: open.filter((item) => item.state.stage === 'l1_support').length,
        candidates: open.filter((item) =>
            ['candidate', 'delayed', 'vetoed'].includes(item.state.stage)).length,
        executable: open.filter((item) => item.state.stage === 'executable').length,
        actualSlashes: cases.filter((item) =>
            ['stake_removed', 'ejected'].includes(item.state.stage)).length,
        ejections: cases.filter((item) => item.state.stage === 'ejected').length,
        stakeAtRisk: stakeAtRisk.toString(),
    };
}

export function stageLabel(stage: CaseStage): string {
    return {
        precursor: 'Duty miss',
        node_offense: 'Node offense',
        awaiting_round: 'Awaiting L1 round',
        l1_support: 'L1 mention',
        candidate: 'Candidate',
        delayed: 'Execution delay',
        executable: 'Executable',
        vetoed: 'Vetoed candidate',
        expired: 'Expired',
        executed: 'Executed',
        stake_removed: 'Stake removed',
        ejected: 'Ejection',
        resolved: 'Closed without slash',
        reorged: 'L1 correction',
    }[stage];
}

function projectCase(
    id: string,
    evidence: Observation[],
    protocol: ProtocolSnapshot | null,
): SlashingCase {
    const observations = [...evidence].sort(compareObservations);
    const first = observations[0];
    const lastObservedAt = observations.reduce(
        (latestAt, observation) => {
            const candidate = observation.provenance.invalidatedAt ??
                observation.provenance.observedAt;
            return candidate > latestAt ? candidate : latestAt;
        },
        first.provenance.observedAt,
    );
    return {
        id,
        network: first.network,
        sequencer: first.sequencer.toLowerCase(),
        lineageId: first.lineageId.toLowerCase(),
        targetEpoch: first.targetEpoch,
        firstObservedAt: first.provenance.observedAt,
        lastObservedAt,
        state: deriveState(observations, protocol),
        observations,
    };
}

function deriveState(
    observations: readonly Observation[],
    protocol: ProtocolSnapshot | null,
): CaseState {
    const canonical = observations.filter((item) => item.provenance.canonical);
    if (canonical.length === 0) {
        return state(
            'reorged',
            'info',
            'Prior L1 evidence was removed by a reorg',
            'The case is retained as a correction, but no canonical evidence currently supports it.',
            unknownReason(),
            false,
        );
    }

    // Observations are sorted, so the last write per kind wins.
    const latest = new Map<ObservationKind, Observation>();
    for (const item of canonical) latest.set(item.kind, item);
    const clock = lineageClock(protocol, canonical[0].lineageId);

    const reason = deriveReason(canonical);
    const ejection = latest.get('stake_status');
    if (ejection && readBoolean(ejection.data.ejected)) {
        const actual = readString(ejection.data.actualAmount);
        return state(
            'ejected',
            'critical',
            'Ejected from the active validator set',
            actual
                ? `${formatAztec(actual)} AZTEC was removed and the remaining stake entered the exit flow.`
                : 'Canonical stake state reports that this sequencer left the active validator set.',
            reason,
            false,
            { actualAmount: actual },
        );
    }

    const slash = latest.get('l1_slash');
    if (slash) {
        const actual = readString(slash.data.amount);
        return state(
            'stake_removed',
            'critical',
            actual ? `${formatAztec(actual)} AZTEC removed from stake` : 'Stake removed',
            'A canonical Rollup Slashed log confirms the actual deduction.',
            reason,
            false,
            {
                actualAmount: actual,
                round: readString(slash.data.round),
            },
        );
    }

    const round = latest.get('l1_round');
    if (round) {
        return roundState(round, reason, latest.get('l1_execution'), clock);
    }

    // Without an L1 ballot, node evidence can reach L1 only through the one
    // round that targets its epoch. Once that round closes it cannot slash.
    const targetEpoch = canonical[0].targetEpoch;
    const votingRound = clock
        ? votingRoundForEpoch(BigInt(targetEpoch), clock.parameters)
        : null;
    const votingClosed = clock !== null && votingRound !== null &&
        clock.currentRound > votingRound;
    const closedWithoutVote = (evidence: string) =>
        `${evidence}, but no L1 ballot targeted this sequencer for epoch ${targetEpoch} ` +
        `before voting round ${votingRound} closed. It can no longer lead to a slash.`;

    const offense = latest.get('node_offense');
    if (offense) {
        const offenseName = humanizeOffense(readString(offense.data.offenseTypeName) ?? 'node offense');
        if (votingClosed) {
            return state(
                'resolved',
                'normal',
                `${offenseName} · no L1 vote before voting closed`,
                closedWithoutVote('This node recorded the offense'),
                reason,
                false,
                { round: String(votingRound) },
            );
        }
        const active = readString(offense.data.status) !== 'withdrawn';
        if (!active) {
            return state(
                'resolved',
                'normal',
                'Node offense no longer active',
                'The observing node withdrew this local offense before any linked L1 continuation.',
                reason,
                false,
            );
        }
        const expectedRound = readString(offense.data.expectedRound);
        const waiting = expectedRound !== null && clock !== null &&
            clock.currentRound < BigInt(expectedRound);
        const amount = readString(offense.data.amount);
        return state(
            waiting ? 'awaiting_round' : 'node_offense',
            'warning',
            waiting ? `${offenseName}; awaiting L1 round ${expectedRound}` : `${offenseName} recorded by this node`,
            amount
                ? `This node assigned a local penalty of ${formatAztec(amount)} AZTEC. No L1 vote is implied.`
                : 'This is local node evidence, not network consensus.',
            reason,
            true,
            {
                requestedAmount: amount,
                round: expectedRound,
            },
        );
    }

    if (votingClosed) {
        return state(
            'resolved',
            'normal',
            'Closed without an L1 vote',
            closedWithoutVote('This node observed a duty problem'),
            reason,
            false,
            { round: String(votingRound) },
        );
    }

    const inactivity = latest.get('inactivity_epoch');
    if (inactivity) {
        const streak = readNumber(inactivity.data.streak) ?? 1;
        const threshold = readNumber(inactivity.data.threshold) ?? 1;
        const missed = readNumber(inactivity.data.missed);
        const total = readNumber(inactivity.data.total);
        return state(
            'precursor',
            streak >= threshold ? 'warning' : 'info',
            `${streak} of ${threshold} qualifying inactive epochs`,
            missed !== null && total !== null
                ? `This node observed ${missed} missed duties out of ${total}. This is not yet an L1 vote.`
                : 'This node observed a qualifying inactive epoch. This is not yet an L1 vote.',
            reason,
            true,
        );
    }

    return state(
        'precursor',
        'info',
        'Missed duty observed',
        'This node observed a duty problem. The inactivity threshold has not yet been met.',
        reason,
        true,
    );
}

const EXECUTED_EXPLANATIONS: Record<string, string> = {
    scanning: 'Contract state marks this round executed. This page is scanning for its execution receipt.',
    paused: 'Contract state marks this round executed. The RPC paused before this page located its execution receipt.',
    unavailable: 'Contract state marks this round executed, but its receipt was not found inside the completed history window.',
};

function roundState(
    observation: Observation,
    reason: CaseReason,
    execution: Observation | undefined,
    clock: LineageClock | null,
): CaseState {
    const data = observation.data;
    const round = readString(data.round) ?? observation.round ?? null;
    const roundStatus = readString(data.status);
    const roundNumber = round !== null && /^\d+$/.test(round) ? BigInt(round) : null;
    // Scans stop at the end of a round's lifetime, so a stored round can be
    // older than its latest observation says. The lineage clock is current.
    const votingClosed = readBoolean(data.stable) ||
        (clock !== null && roundNumber !== null && clock.currentRound > roundNumber);
    const lifetimeEnded = roundStatus === 'expired' || (
        clock !== null && roundNumber !== null &&
        clock.currentRound > roundNumber + BigInt(clock.parameters.lifetimeRounds)
    );
    const amount = readString(data.amount);
    const payloadAddress = readString(data.payloadAddress);
    const support = readNumber(data.support) ?? 0;
    const quorum = readNumber(data.quorum);
    const common = {
        requestedAmount: amount,
        payloadAddress,
        round,
    };

    if (readBoolean(data.escaped)) {
        return state(
            'resolved',
            'normal',
            'Excluded by the censorship-resistance escape hatch',
            'Votes were visible, but the target epoch was in an open escape-hatch window and the contract excluded it from the tally.',
            reason,
            false,
            common,
        );
    }

    if (readBoolean(data.isExecuted) || roundStatus === 'executed') {
        if (!amount) {
            return state(
                'resolved',
                'normal',
                'Round executed without slashing this sequencer',
                'The round closed onchain, but its final tally contained no action for this target.',
                reason,
                false,
                common,
            );
        }
        if (execution) {
            return state(
                'resolved',
                'normal',
                `Round executed · ${formatAztec(amount)} AZTEC requested`,
                'The execution receipt was inspected and contains no Rollup Slashed log for this sequencer.',
                reason,
                false,
                common,
            );
        }
        const receiptStatus = readString(data.executionReceiptStatus);
        return state(
            'executed',
            'critical',
            `Round executed · ${formatAztec(amount)} AZTEC requested`,
            EXECUTED_EXPLANATIONS[receiptStatus ?? ''] ??
                'The action payload was called. A Rollup Slashed log is still required to confirm this sequencer’s deduction.',
            reason,
            false,
            common,
        );
    }
    // A veto is permanent and a closed tally cannot move to another payload
    // address, so a vetoed candidate is final once voting closes.
    if (amount && readBoolean(data.isVetoed) && votingClosed) {
        return state(
            'vetoed',
            'info',
            'Exact candidate payload is vetoed',
            'Voting has closed, so this vetoed payload is final and can never execute.',
            reason,
            false,
            common,
        );
    }
    if (amount && lifetimeEnded) {
        return state(
            'expired',
            'normal',
            'Candidate expired without execution',
            'The execution lifetime ended. This candidate can no longer execute.',
            reason,
            false,
            common,
        );
    }
    if (readBoolean(data.isVetoed)) {
        return state(
            'vetoed',
            'info',
            'Exact candidate payload is vetoed',
            'This veto applies to the displayed predicted address. A changed tally can produce another address.',
            reason,
            true,
            common,
        );
    }
    if (['newly-executable', 'executable'].includes(roundStatus ?? '')) {
        return state(
            'executable',
            'critical',
            amount ? `${formatAztec(amount)} AZTEC candidate is executable now` : 'Candidate is executable now',
            readBoolean(data.isExecutionPaused)
                ? 'Execution is currently paused, but the candidate remains inside its execution window.'
                : 'The execution delay has passed and the candidate has not expired.',
            reason,
            true,
            {
                ...common,
                nextTransition: nextTransition(data, 'expiry'),
            },
        );
    }
    if (amount) {
        return state(
            votingClosed ? 'delayed' : 'candidate',
            'critical',
            `${formatAztec(amount)} AZTEC candidate`,
            votingClosed
                ? 'Voting has closed. The candidate is waiting for its execution window.'
                : 'The current tally has an action, but it can still change until the voting round closes.',
            reason,
            true,
            {
                ...common,
                nextTransition: nextTransition(data, votingClosed ? 'executable' : 'votingCloses'),
            },
        );
    }

    if (votingClosed) {
        return state(
            'resolved',
            'normal',
            'Voting closed below quorum',
            `${support}${quorum ? ` of ${quorum}` : ''} L1 ballot${support === 1 ? '' : 's'} supported a penalty before round ${round} closed. The final tally contains no action for this sequencer.`,
            reason,
            false,
            common,
        );
    }

    return state(
        'l1_support',
        'warning',
        quorum
            ? `${support} of ${quorum} L1 ballots support a penalty`
            : `${support} L1 ballot${support === 1 ? '' : 's'} support a penalty`,
        'The sequencer is mentioned in L1 voting. The tally does not currently produce a candidate action.',
        reason,
        true,
        common,
    );
}

type StateOverrides = Partial<Pick<
    CaseState,
    'requestedAmount' | 'actualAmount' | 'payloadAddress' | 'round' | 'nextTransition'
>>;

function state(
    stage: CaseStage,
    urgency: CaseUrgency,
    headline: string,
    explanation: string,
    reason: CaseReason,
    active: boolean,
    overrides: StateOverrides = {},
): CaseState {
    return {
        stage,
        urgency,
        headline,
        explanation,
        reason,
        nextTransition: null,
        requestedAmount: null,
        actualAmount: null,
        payloadAddress: null,
        round: null,
        active,
        ...overrides,
    };
}

function deriveReason(observations: readonly Observation[]): CaseReason {
    const offenseEvidence = observations.filter((item) => item.kind === 'node_offense');
    const latestOffense = offenseEvidence[offenseEvidence.length - 1];
    if (latestOffense) {
        return {
            label: humanizeOffense(
                readString(latestOffense.data.offenseTypeName) ?? 'Node offense',
            ),
            provenance: 'node_evidence',
            evidenceIds: offenseEvidence.map((item) => item.id),
        };
    }
    const inactivity = observations.filter((item) =>
        item.kind === 'inactivity_epoch' || item.kind === 'duty_miss');
    if (inactivity.length > 0) {
        return {
            label: 'Inactivity',
            provenance: 'node_evidence',
            evidenceIds: inactivity.map((item) => item.id),
        };
    }
    return unknownReason();
}

function unknownReason(): CaseReason {
    return {
        label: 'Reason unknown on L1',
        provenance: 'unknown_on_l1',
        evidenceIds: [],
    };
}

const NEXT_TRANSITIONS = {
    expiry: { label: 'Expires', slotKey: 'expirySlot', atKey: 'expiryAt' },
    executable: { label: 'Executable', slotKey: 'executableSlot', atKey: 'executableAt' },
    votingCloses: { label: 'Voting closes', slotKey: 'roundEndSlot', atKey: 'roundEndAt' },
} as const;

function nextTransition(
    data: Record<string, unknown>,
    kind: keyof typeof NEXT_TRANSITIONS,
) {
    const fields = NEXT_TRANSITIONS[kind];
    return {
        label: fields.label,
        slot: readString(data[fields.slotKey]),
        at: readString(data[fields.atKey]),
    };
}

interface LineageClock {
    currentRound: bigint;
    parameters: SlashingLineage['parameters'];
}

// Protocol time for one case. Without a snapshot of the case's lineage, no
// case is closed by time alone.
function lineageClock(
    protocol: ProtocolSnapshot | null,
    lineageId: string,
): LineageClock | null {
    const lineage = protocol?.lineages.find((item) =>
        item.proposerAddress.toLowerCase() === lineageId.toLowerCase());
    return lineage
        ? { currentRound: BigInt(lineage.currentRound), parameters: lineage.parameters }
        : null;
}

function compareObservations(left: Observation, right: Observation): number {
    return left.provenance.observedAt.localeCompare(right.provenance.observedAt) ||
        left.id.localeCompare(right.id);
}

export function compareCases(left: SlashingCase, right: SlashingCase): number {
    return Number(right.state.active) - Number(left.state.active) ||
        URGENCY_RANK[right.state.urgency] - URGENCY_RANK[left.state.urgency] ||
        STAGE_RANK[right.state.stage] - STAGE_RANK[left.state.stage] ||
        right.lastObservedAt.localeCompare(left.lastObservedAt);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean {
    return value === true;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
