import { formatAztec, humanizeOffense } from './format.ts';
import { roundEndsAt } from './lifecycle.ts';
import type {
    CaseStage,
    Observation,
    ObservationKind,
    ProtocolSnapshot,
    SlashingCase,
} from './types.ts';

// One sequencer's cases as a story: what the node saw in each epoch, what L1
// did about it, and how it ended. Every sentence states a recorded fact; no
// time is guessed, and the reason stays labelled as node evidence.

export type HistoryOutcome =
    | 'open'
    | 'slashed'
    | 'ejected'
    | 'executed'
    | 'vetoed'
    | 'expired'
    | 'not_slashed'
    | 'corrected';

export interface DutySummary {
    missed: number | null;
    total: number | null;
    firstMissed: string | null;
    inactive: boolean;
    streak: number | null;
    threshold: number | null;
}

export interface VoteSummary {
    round: string;
    support: number;
    quorum: number | null;
    amount: string | null;
    votingClosesAt: string | null;
    executableAt: string | null;
}

export interface OffenseSummary {
    label: string;
    amount: string | null;
    // The node dropped it before its voting round closed. Later removal is
    // the node's routine expiry and says nothing about the offense.
    cleared: boolean;
}

export interface HistoryEntry {
    item: SlashingCase;
    epochStartsAt: string | null;
    duty: DutySummary | null;
    offense: OffenseSummary | null;
    vote: VoteSummary | null;
    outcome: HistoryOutcome;
    // 1 for the sequencer's first confirmed slash, 2 for the second, and so on.
    slashNumber: number | null;
    removedAmount: string | null;
    slashTransactionHash: string | null;
    // The block time of the Slashed log, when the source recorded it.
    slashedAt: string | null;
    // The stake left right after the slash block, when the source read it.
    stakeAfter: string | null;
}

const OUTCOME_BY_STAGE: Partial<Record<CaseStage, HistoryOutcome>> = {
    stake_removed: 'slashed',
    ejected: 'ejected',
    executed: 'executed',
    expired: 'expired',
    resolved: 'not_slashed',
    reorged: 'corrected',
};

// Oldest target epoch first, so slash numbers read in order.
export function sequencerHistory(
    cases: readonly SlashingCase[],
    protocol: ProtocolSnapshot | null,
): HistoryEntry[] {
    let slashes = 0;
    return [...cases]
        .sort((left, right) =>
            compareNumeric(left.targetEpoch, right.targetEpoch) ||
            left.firstObservedAt.localeCompare(right.firstObservedAt))
        .map((item) => {
            const canonical = item.observations.filter((observation) =>
                observation.provenance.canonical);
            const outcome = item.state.active
                ? 'open'
                : item.state.stage === 'vetoed'
                    ? 'vetoed'
                    : OUTCOME_BY_STAGE[item.state.stage] ?? 'not_slashed';
            const slashed = outcome === 'slashed' || outcome === 'ejected';
            if (slashed) slashes += 1;
            const slash = latest(canonical, 'l1_slash');
            return {
                item,
                epochStartsAt: epochStart(protocol, item.targetEpoch),
                duty: dutySummary(canonical),
                offense: offenseSummary(canonical, protocol, item.lineageId),
                vote: voteSummary(canonical),
                outcome,
                slashNumber: slashed ? slashes : null,
                removedAmount: item.state.actualAmount,
                slashTransactionHash: slash?.provenance.transactionHash ?? null,
                slashedAt: slash?.provenance.blockTime ?? null,
                stakeAfter: slash ? readDigits(slash.data.stakeAfter) : null,
            };
        });
}

// Plain-language sentences for one entry, in the order events happened.
export function historySentences(
    entry: HistoryEntry,
    protocol: ProtocolSnapshot | null,
): string[] {
    const sentences: string[] = [];
    const { duty, offense, vote, outcome } = entry;
    if (duty) sentences.push(dutySentence(duty, protocol));
    if (offense) {
        sentences.push(offense.amount
            ? `Offense recorded by this node: ${offense.label} (${formatAztec(offense.amount)} AZTEC penalty).`
            : `Offense recorded by this node: ${offense.label}.`);
        if (offense.cleared) {
            sentences.push('The node cleared it before its voting round closed, so it did not vote on it.');
        }
    }
    if (vote) {
        sentences.push(voteSentence(vote, entry.item.state.active));
    }
    else if (!entry.item.state.active && outcome === 'not_slashed' && entry.item.state.round) {
        sentences.push(`No L1 votes targeted it before voting round ${entry.item.state.round} closed.`);
    }
    switch (outcome) {
        case 'slashed':
            if (entry.removedAmount) {
                sentences.push(entry.stakeAfter
                    ? `${formatAztec(entry.removedAmount)} AZTEC was removed from stake, leaving ${formatAztec(entry.stakeAfter)} AZTEC.`
                    : `${formatAztec(entry.removedAmount)} AZTEC was removed from stake.`);
            }
            break;
        case 'ejected':
            sentences.push(entry.removedAmount
                ? `${formatAztec(entry.removedAmount)} AZTEC was removed, and the remaining stake fell below the ejection threshold: the sequencer was ejected.`
                : 'The sequencer was ejected from the active validator set.');
            if (entry.stakeAfter) {
                sentences.push(`${formatAztec(entry.stakeAfter)} AZTEC waits in its exit.`);
            }
            break;
        case 'executed':
            sentences.push('The round was executed; the actual deduction is not yet confirmed.');
            break;
        case 'vetoed':
            sentences.push('The Slash Veto Council vetoed the payload, so it can never execute.');
            break;
        case 'expired':
            sentences.push('Nobody executed it before its lifetime ended, so it can no longer slash.');
            break;
        case 'open':
            sentences.push(`Now: ${entry.item.state.headline}.`);
            break;
        case 'corrected':
            sentences.push(entry.item.state.explanation);
            break;
        case 'not_slashed':
            // Quorum without a slash, or no evidence to narrate: say why.
            if (vote?.amount || (!duty && !offense && !vote)) {
                sentences.push(entry.item.state.explanation);
            }
            break;
    }
    return sentences;
}

export function historyOutcomeLabel(entry: HistoryEntry): string {
    switch (entry.outcome) {
        case 'slashed':
            return entry.removedAmount
                ? `Slash #${entry.slashNumber} · −${formatAztec(entry.removedAmount)} AZTEC`
                : `Slash #${entry.slashNumber}`;
        case 'ejected':
            return `Slash #${entry.slashNumber} · ejected`;
        case 'executed':
            return 'Executed';
        case 'vetoed':
            return 'Vetoed';
        case 'expired':
            return 'Expired';
        case 'corrected':
            return 'L1 correction';
        case 'open':
            return 'Open';
        case 'not_slashed':
            return 'No slash';
    }
}

// What this case was about, in a few words.
export function historyTitle(entry: HistoryEntry): string {
    if (entry.offense) return `${entry.offense.label} offense`;
    if (entry.duty?.inactive) return 'Inactive epoch';
    if (entry.duty) return 'Missed duty';
    if (entry.vote) return 'L1 slash vote';
    return entry.item.state.headline;
}

const DUTY_PHRASES: Record<string, string> = {
    'attestation-missed': 'missed an attestation',
    'blocks-missed': 'missed its block proposals',
    'checkpoint-missed': 'missed its checkpoint proposal',
    'checkpoint-invalid': 'proposed an invalid checkpoint',
    'checkpoint-unvalidated': 'proposed a checkpoint that was never validated',
};

function dutySentence(duty: DutySummary, protocol: ProtocolSnapshot | null): string {
    const counts = duty.missed !== null && duty.total !== null
        ? duty.missed === duty.total
            ? `Missed all ${duty.total} duties`
            : `Missed ${duty.missed} of ${duty.total} duties`
        : null;
    if (duty.inactive) {
        const missed = counts ?? 'Missed enough duties to be inactive';
        if (duty.streak === null || duty.threshold === null) {
            return `${missed}: an inactive epoch.`;
        }
        return duty.streak >= duty.threshold
            ? `${missed}: its ${ordinal(duty.streak)} inactive epoch in a row (an offense needs ${duty.threshold}).`
            : `${missed}: its ${ordinal(duty.streak)} inactive epoch in a row; an offense needs ${duty.threshold}, so none yet.`;
    }
    const first = duty.firstMissed ? DUTY_PHRASES[duty.firstMissed] ?? null : null;
    const percentage = protocol?.inactivity
        ? `${Math.round(protocol.inactivity.targetPercentage * 100)}%`
        : null;
    const notInactive = percentage
        ? `Not an inactive epoch (under ${percentage} of duties missed).`
        : 'Not an inactive epoch.';
    if (counts) {
        return `${counts}${first ? ` (first: ${first})` : ''}. ${notInactive}`;
    }
    return `${first ? capitalize(first) : 'Missed a duty'}. ${notInactive}`;
}

function voteSentence(vote: VoteSummary, active: boolean): string {
    const ballots = vote.quorum === null
        ? `${vote.support} vote${vote.support === 1 ? '' : 's'}`
        : `${vote.support} vote${vote.support === 1 ? '' : 's'} (quorum ${vote.quorum})`;
    if (vote.amount) {
        return `L1 voting round ${vote.round}: ${ballots} for a ${formatAztec(vote.amount)} AZTEC slash.`;
    }
    return active
        ? `L1 voting round ${vote.round}: ${ballots} so far, not yet enough to slash.`
        : `L1 voting round ${vote.round}: ${ballots}, not enough to slash.`;
}

function dutySummary(observations: readonly Observation[]): DutySummary | null {
    const inactivity = latest(observations, 'inactivity_epoch');
    const miss = latest(observations, 'duty_miss');
    if (!inactivity && !miss) return null;
    const source = inactivity ?? miss!;
    return {
        missed: readNumber(source.data.missed),
        total: readNumber(source.data.total),
        firstMissed: miss ? readString(miss.data.status) : null,
        inactive: inactivity !== undefined,
        streak: inactivity ? readNumber(inactivity.data.streak) : null,
        threshold: inactivity ? readNumber(inactivity.data.threshold) : null,
    };
}

function offenseSummary(
    observations: readonly Observation[],
    protocol: ProtocolSnapshot | null,
    lineageId: string,
): OffenseSummary | null {
    const offense = latest(observations, 'node_offense');
    if (!offense) return null;
    return {
        label: humanizeOffense(readString(offense.data.offenseTypeName) ?? 'node'),
        amount: readString(offense.data.amount),
        cleared: offenseCleared(offense, protocol, lineageId),
    };
}

// Whether a node offense left the node's list before its voting round closed.
// Nodes expire offenses on their own only after that round, so an earlier
// removal is the node clearing it.
export function offenseCleared(
    offense: Observation,
    protocol: ProtocolSnapshot | null,
    lineageId: string,
): boolean {
    if (readString(offense.data.status) !== 'withdrawn') return false;
    const closesAt = roundEndsAt(protocol, lineageId, readString(offense.data.expectedRound));
    return closesAt !== null && offense.provenance.observedAt < closesAt;
}

function voteSummary(observations: readonly Observation[]): VoteSummary | null {
    const round = latest(observations, 'l1_round');
    if (!round) return null;
    return {
        round: readString(round.data.round) ?? round.round ?? '?',
        support: readNumber(round.data.support) ?? 0,
        quorum: readNumber(round.data.quorum),
        amount: readString(round.data.amount),
        votingClosesAt: readString(round.data.roundEndAt),
        executableAt: readString(round.data.executableAt),
    };
}

function latest(
    observations: readonly Observation[],
    kind: ObservationKind,
): Observation | undefined {
    for (let index = observations.length - 1; index >= 0; index -= 1) {
        if (observations[index].kind === kind) return observations[index];
    }
    return undefined;
}

export function epochStart(
    protocol: ProtocolSnapshot | null,
    epoch: string,
): string | null {
    if (!protocol || !/^\d+$/.test(epoch)) return null;
    const seconds = BigInt(protocol.genesisTime) +
        BigInt(epoch) * BigInt(protocol.epochDurationSlots) *
        BigInt(protocol.slotDurationSeconds);
    return new Date(Number(seconds) * 1_000).toISOString();
}

function ordinal(value: number): string {
    const suffix = value % 100 >= 11 && value % 100 <= 13
        ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th';
    return `${value}${suffix}`;
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function compareNumeric(left: string, right: string): number {
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return left.localeCompare(right);
    const difference = BigInt(left) - BigInt(right);
    return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readDigits(value: unknown): string | null {
    return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
