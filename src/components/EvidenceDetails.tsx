import type {
    Observation,
    ProtocolSnapshot,
    SlashingCase,
} from '@shared/protocol/index.ts';
import {
    formatAztec,
    humanizeOffense,
    offenseCleared,
    roundEndsAt,
} from '@shared/protocol/index.ts';
import { explorer } from '@/lib/explorer';
import { formatDateTime } from '@/lib/time';
import { CopyButton } from './CopyButton';

export function EvidenceDetails({
    item,
    protocol,
}: {
    item: SlashingCase;
    protocol: ProtocolSnapshot | null;
}) {
    const evidence = combineRepeatedOffenses(
        combineHistoricalExecutions(item.observations),
    );

    return (
        <details className="mt-5 border-t-3 border-whisper-white/30 pt-4">
            <summary className="min-h-11 cursor-pointer font-black uppercase text-aqua">
                Evidence &amp; protocol details ({evidence.length})
            </summary>
            <div className="mt-3 grid gap-3">
                {evidence.map(({ observation, slash, laterStatus }) => {
                    const provenance = slash?.provenance ?? observation.provenance;
                    return (
                        <div
                            key={slash ? `${observation.id}:${slash.id}` : observation.id}
                            className="border-3 border-whisper-white/30 bg-malachite p-3"
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="text-xs font-black uppercase text-chartreuse">
                                    {sourceLabel(observation.source)} · {
                                        slash ? 'Executed slash' : KIND_LABELS[observation.kind]
                                    }
                                </span>
                                <time
                                    className="text-xs font-bold text-whisper-white/60"
                                    title="When this source observed it"
                                >
                                    seen {formatDateTime(provenance.observedAt)}
                                </time>
                            </div>
                            <dl className="mt-2 grid gap-1 text-xs font-bold text-whisper-white/75 sm:grid-cols-2">
                                {evidenceRows(observation, slash, laterStatus, protocol).map(([label, value]) => (
                                    <Row key={label} label={label} value={value} />
                                ))}
                                {provenance.blockNumber &&
                                    <Row label="L1 block" value={provenance.blockNumber} />}
                            </dl>
                            {provenance.transactionHash && (
                                <div className="mt-2 flex min-w-0 items-center gap-2">
                                    <a
                                        className="min-w-0 break-all font-mono text-xs font-black text-aqua underline"
                                        href={`${explorer(protocol?.chainId)}/tx/${provenance.transactionHash}`}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {provenance.transactionHash}
                                    </a>
                                    <CopyButton value={provenance.transactionHash} />
                                </div>
                            )}
                        </div>
                    );
                })}
                <div className="break-all border-3 border-orchid bg-aubergine p-3 text-xs font-bold">
                    <span className="text-orchid">Case key:</span> {item.id}
                </div>
            </div>
        </details>
    );
}

const KIND_LABELS: Record<Observation['kind'], string> = {
    duty_miss: 'Missed duty',
    inactivity_epoch: 'Inactive epoch',
    node_offense: 'Node offense',
    l1_round: 'Voting round',
    l1_execution: 'Round executed',
    l1_slash: 'Stake slashed',
    stake_status: 'Stake status',
};

const DUTY_LABELS: Record<string, string> = {
    'attestation-missed': 'Attestation',
    'blocks-missed': 'Block proposals',
    'checkpoint-missed': 'Checkpoint proposal',
    'checkpoint-invalid': 'Invalid checkpoint proposed',
    'checkpoint-unvalidated': 'Checkpoint never validated',
};

const ROUND_STATUS_LABELS: Record<string, string> = {
    'below-quorum': 'Below quorum',
    'quorum-reached': 'Quorum reached',
    'newly-executable': 'Executable',
    executable: 'Executable',
    executed: 'Executed',
    expired: 'Expired',
};

// The facts that matter for each kind of evidence, in plain labels.
function evidenceRows(
    observation: Observation,
    slash: Observation | undefined,
    laterStatus: Observation | undefined,
    protocol: ProtocolSnapshot | null,
): Array<[string, string]> {
    const rows: Array<[string, string | null]> = [];
    const value = (key: string) => dataString(observation, key);
    const aztec = (amount: string | null) =>
        amount === null ? null : `${formatAztec(amount)} AZTEC`;
    const missed = value('missed');
    const total = value('total');
    const missedDuties = missed !== null && total !== null
        ? `${missed} of ${total} duties`
        : null;

    const slashFacts = (source: Observation): Array<[string, string | null]> => [
        ['Block time', source.provenance.blockTime
            ? formatDateTime(source.provenance.blockTime)
            : null],
        ['Stake left', aztec(dataString(source, 'stakeAfter'))],
        ['Ejection threshold', aztec(dataString(source, 'ejectionThreshold'))],
    ];

    if (slash) {
        const support = value('support');
        const quorum = value('quorum');
        rows.push(
            ['Target epoch', observation.targetEpoch],
            ['Round', observation.round ?? null],
            ['L1 support', support && quorum ? `${support} / ${quorum}` : null],
            ['Requested', aztec(value('amount'))],
            ['Actual', aztec(dataString(slash, 'amount'))],
            ['Payload', value('payloadAddress')],
            ...slashFacts(slash),
        );
    }
    else {
        switch (observation.kind) {
            case 'duty_miss':
                rows.push(
                    ['First missed', DUTY_LABELS[value('status') ?? ''] ?? value('status')],
                    ['Slot', observation.slot ?? null],
                    ['Missed', missedDuties],
                );
                break;
            case 'inactivity_epoch': {
                const streak = value('streak');
                const threshold = value('threshold');
                const first = value('firstMissedSlot');
                const last = value('lastMissedSlot');
                rows.push(
                    ['Missed', missedDuties],
                    ['Inactive epochs in a row', streak
                        ? threshold ? `${streak} (offense at ${threshold})` : streak
                        : null],
                    ['Missed slots', first && last ? `${first}–${last}` : null],
                );
                break;
            }
            case 'node_offense': {
                const unit = value('timeUnit');
                const target = value('epochOrSlot');
                rows.push(
                    ['Offense', humanizeOffense(value('offenseTypeName') ?? 'unknown')],
                    ['Penalty', aztec(value('amount'))],
                    ['For', unit && target ? `${unit} ${target}` : null],
                    ['Voting round', value('expectedRound')],
                    ['Node pending list', pendingListStatus(laterStatus ?? observation, protocol)],
                );
                break;
            }
            case 'l1_round': {
                const support = value('support');
                const quorum = value('quorum');
                const roundStatus = value('status');
                const roundEndAt = value('roundEndAt');
                const executableAt = value('executableAt');
                rows.push(
                    ['Round', observation.round ?? value('round')],
                    ['Votes', support ? quorum ? `${support} (quorum ${quorum})` : support : null],
                    ['Slash amount', aztec(value('amount'))],
                    ['Status', roundStatus ? ROUND_STATUS_LABELS[roundStatus] ?? roundStatus : null],
                    ['Payload', value('payloadAddress')],
                    ['Voting closes', roundEndAt && formatDateTime(roundEndAt)],
                    ['Executable from', value('amount') && executableAt
                        ? formatDateTime(executableAt)
                        : null],
                );
                break;
            }
            case 'l1_slash':
                rows.push(
                    ['Removed', aztec(value('amount'))],
                    ['Round', observation.round ?? null],
                    ...slashFacts(observation),
                );
                break;
            case 'l1_execution':
                rows.push(
                    ['Round', observation.round ?? null],
                    ['Slashes in transaction', value('slashCount')],
                );
                break;
            case 'stake_status':
                rows.push(['Status', value('status') === 'zombie'
                    ? 'Ejected (zombie)'
                    : value('status') === 'exiting' ? 'Exiting' : value('status')]);
                break;
        }
    }
    return rows.filter((row): row is [string, string] => row[1] !== null);
}

// A node drops an offense from its pending list on its own a few rounds after
// the offense's voting round. Only an earlier removal is the node clearing it.
function pendingListStatus(
    offense: Observation,
    protocol: ProtocolSnapshot | null,
): string {
    if (dataString(offense, 'status') !== 'withdrawn') return 'Listed';
    const removed = formatDateTime(offense.provenance.observedAt);
    if (offenseCleared(offense, protocol, offense.lineageId)) {
        return `Cleared by the node before its voting round closed (${removed})`;
    }
    const round = dataString(offense, 'expectedRound');
    return roundEndsAt(protocol, offense.lineageId, round)
        ? `Expired after voting round ${round} closed (${removed})`
        : `Removed ${removed}`;
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <dt className="inline text-whisper-white/50">{label}: </dt>
            <dd className="inline break-all">{value}</dd>
        </div>
    );
}

interface EvidenceItem {
    observation: Observation;
    slash?: Observation;
    // A later report of the same node offense, such as its withdrawal.
    laterStatus?: Observation;
}

// The node offense feed repeats one offense with each status change; it is
// one piece of evidence, shown with its latest status.
function combineRepeatedOffenses(items: EvidenceItem[]): EvidenceItem[] {
    const firstByOffense = new Map<string, EvidenceItem>();
    return items.flatMap((entry) => {
        const offenseId = entry.observation.kind === 'node_offense'
            ? dataString(entry.observation, 'id')
            : null;
        if (offenseId === null) return [entry];
        const first = firstByOffense.get(offenseId);
        if (!first) {
            const kept = { ...entry };
            firstByOffense.set(offenseId, kept);
            return [kept];
        }
        first.laterStatus = entry.observation;
        return [];
    });
}

function combineHistoricalExecutions(
    observations: readonly Observation[],
): EvidenceItem[] {
    const slashByRoundId = new Map<string, Observation>();
    const pairedSlashIds = new Set<string>();
    for (const round of observations) {
        if (
            round.kind !== 'l1_round' ||
            round.data.historicalExecution !== true
        ) {
            continue;
        }
        const slash = observations.find((candidate) =>
            !pairedSlashIds.has(candidate.id) &&
            isSameExecution(round, candidate));
        if (!slash) continue;
        slashByRoundId.set(round.id, slash);
        pairedSlashIds.add(slash.id);
    }
    return observations.flatMap((observation) => {
        if (pairedSlashIds.has(observation.id)) return [];
        return [{
            observation,
            slash: slashByRoundId.get(observation.id),
        }];
    });
}

function isSameExecution(round: Observation, slash: Observation): boolean {
    const transactionHash = round.provenance.transactionHash;
    const actionIndex = dataString(round, 'actionIndex');
    return (
        slash.kind === 'l1_slash' &&
        transactionHash !== undefined &&
        actionIndex !== null &&
        sameHex(transactionHash, slash.provenance.transactionHash) &&
        sameHex(round.provenance.blockHash, slash.provenance.blockHash) &&
        round.provenance.blockNumber === slash.provenance.blockNumber &&
        round.provenance.canonical === slash.provenance.canonical &&
        sameHex(round.lineageId, slash.lineageId) &&
        sameHex(round.sequencer, slash.sequencer) &&
        round.targetEpoch === slash.targetEpoch &&
        round.round !== undefined &&
        round.round === slash.round &&
        actionIndex === dataString(slash, 'actionIndex')
    );
}

function dataString(
    observation: Observation,
    key: string,
): string | null {
    const value = observation.data[key];
    return typeof value === 'string' || typeof value === 'number' ||
        typeof value === 'bigint'
        ? String(value)
        : null;
}

function sameHex(
    left: string | undefined,
    right: string | undefined,
): boolean {
    return left !== undefined &&
        right !== undefined &&
        left.toLowerCase() === right.toLowerCase();
}

function sourceLabel(source: string): string {
    return {
        aztec_sentinel: 'Sentinel',
        aztec_node: 'Aztec node',
        ethereum_l1: 'Ethereum L1',
    }[source] ?? source;
}
