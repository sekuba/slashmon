import { useState, type ReactNode } from 'react';
import {
    historyOutcomeLabel,
    historySentences,
    historyTitle,
    sequencerHistory,
    type HistoryEntry,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import { explorer } from '@/lib/explorer';
import { formatDateParts, formatDateTime, relativeTime } from '@/lib/time';
import { CaseTimeline } from './CaseTimeline';

const INITIAL_ROWS = 10;

// One sequencer's cases as a dated story, one epoch per row. Each row opens
// into the full case timeline and its evidence.
export function SequencerHistory({
    cases,
    protocol,
    selectedCaseId,
    onOpenProtocolGuide,
    footer,
}: {
    cases: readonly SlashingCase[];
    protocol: ProtocolSnapshot | null;
    selectedCaseId: string | null;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
    footer?: ReactNode;
}) {
    const [showAll, setShowAll] = useState(false);
    const entries = sequencerHistory(cases, protocol);
    const selectedIndex = entries.findIndex((entry) => entry.item.id === selectedCaseId);
    const collapsed = showAll ? 0 : Math.max(0, entries.length - INITIAL_ROWS);
    // A linked case is never hidden behind "show earlier".
    const firstShown = selectedIndex >= 0 ? Math.min(collapsed, selectedIndex) : collapsed;

    return (
        <section className="mt-5 border-t-3 border-chartreuse pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-lg font-black uppercase text-chartreuse">What happened</h3>
                <span className="text-xs font-bold text-whisper-white/60">
                    {entries.length} epoch{entries.length === 1 ? '' : 's'} with evidence · oldest first
                </span>
            </div>
            <p className="mt-1 text-xs font-bold text-whisper-white/60">
                One row per epoch in which something was observed. Open a row for its full
                timeline and evidence. Inactive epochs count “in a row” across the epochs in
                which the sequencer had duties; epochs without duties are skipped.
            </p>
            {firstShown > 0 && (
                <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="mt-3 min-h-11 text-xs font-black uppercase text-aqua underline decoration-2 underline-offset-4 hover:text-chartreuse"
                >
                    Show {firstShown} earlier epoch{firstShown === 1 ? '' : 's'}
                </button>
            )}
            <ol className="mt-3 grid gap-3">
                {entries.slice(firstShown).map((entry) => (
                    <HistoryRow
                        key={entry.item.id}
                        entry={entry}
                        protocol={protocol}
                        selected={entry.item.id === selectedCaseId}
                        onOpenProtocolGuide={onOpenProtocolGuide}
                    />
                ))}
            </ol>
            {footer}
        </section>
    );
}

function HistoryRow({
    entry,
    protocol,
    selected,
    onOpenProtocolGuide,
}: {
    entry: HistoryEntry;
    protocol: ProtocolSnapshot | null;
    selected: boolean;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const isOpen = selected || expanded;
    const tone = outcomeTone(entry);
    const next = entry.item.state.nextTransition;
    const started = entry.epochStartsAt ? formatDateParts(entry.epochStartsAt) : null;
    const slashed = entry.outcome === 'slashed' || entry.outcome === 'ejected';

    return (
        <li>
            <details
                open={isOpen}
                onToggle={(event) => {
                    if (!selected) setExpanded(event.currentTarget.open);
                }}
                className={`border-3 bg-brand-black ${tone.border}`}
            >
                <summary className="cursor-pointer list-none p-3 sm:p-4 [&::-webkit-details-marker]:hidden">
                    <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
                        <div>
                            <p className="text-xs font-black uppercase tracking-[0.12em] text-aqua">
                                Epoch {entry.item.targetEpoch}
                            </p>
                            {entry.epochStartsAt && started && (
                                <time
                                    dateTime={entry.epochStartsAt}
                                    title="When the epoch started"
                                    className="block text-xs font-bold text-whisper-white/60"
                                >
                                    {started.date}
                                    <span className="block">{started.time}</span>
                                </time>
                            )}
                        </div>
                        <div className="min-w-0">
                            <p className="font-black text-whisper-white">{historyTitle(entry)}</p>
                            <p className="mt-1 text-sm font-bold text-whisper-white/75">
                                {historySentences(entry, protocol).join(' ')}
                            </p>
                            {next && (
                                <p className="mt-1 text-xs font-black uppercase text-aqua">
                                    Next: {next.label}
                                    {next.at
                                        ? ` · ${relativeTime(next.at)} (${formatDateTime(next.at)})`
                                        : next.slot ? ` · slot ${next.slot}` : ''}
                                </p>
                            )}
                            {slashed && (entry.slashedAt || entry.vote?.executableAt || entry.slashTransactionHash) && (
                                <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs font-bold text-whisper-white/60">
                                    {entry.slashedAt ? (
                                        <span title="Time of the L1 block with the Slashed log">
                                            Slashed {formatDateTime(entry.slashedAt)}
                                        </span>
                                    ) : entry.vote?.executableAt && (
                                        <span title="A slash executes after its voting round closes and the execution delay passes">
                                            Executable from {formatDateTime(entry.vote.executableAt)}
                                        </span>
                                    )}
                                    {entry.slashTransactionHash && (
                                        <a
                                            href={`${explorer(protocol?.chainId)}/tx/${entry.slashTransactionHash}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="font-black uppercase text-aqua underline decoration-2 underline-offset-4 hover:text-chartreuse"
                                        >
                                            Slash transaction ↗
                                        </a>
                                    )}
                                </p>
                            )}
                        </div>
                        <span className={`w-fit border-3 border-brand-black px-2 py-1 text-xs font-black uppercase text-brand-black ${tone.badge}`}>
                            {historyOutcomeLabel(entry)}
                        </span>
                    </div>
                    <span className="mt-2 block text-[0.65rem] font-black uppercase tracking-[0.12em] text-whisper-white/50">
                        {isOpen ? 'Hide timeline & evidence −' : 'Show timeline & evidence +'}
                    </span>
                </summary>
                {isOpen && (
                    <div className="border-t-3 border-whisper-white/20 p-2 sm:p-4">
                        <CaseTimeline
                            item={entry.item}
                            protocol={protocol}
                            selected={selected}
                            onOpenProtocolGuide={onOpenProtocolGuide}
                        />
                    </div>
                )}
            </details>
        </li>
    );
}

function outcomeTone(entry: HistoryEntry): { border: string; badge: string } {
    switch (entry.outcome) {
        case 'slashed':
        case 'ejected':
        case 'executed':
            return { border: 'border-vermillion', badge: 'bg-vermillion' };
        case 'open':
            return entry.item.state.urgency === 'critical'
                ? { border: 'border-vermillion', badge: 'bg-vermillion' }
                : entry.item.state.urgency === 'warning'
                    ? { border: 'border-orchid', badge: 'bg-orchid' }
                    : { border: 'border-aqua', badge: 'bg-aqua' };
        case 'corrected':
            return { border: 'border-aqua', badge: 'bg-aqua' };
        default:
            return { border: 'border-whisper-white/30', badge: 'bg-chartreuse' };
    }
}
