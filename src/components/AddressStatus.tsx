import { useEffect, useState } from 'react';
import {
    CLOSED_CASE_RETENTION_DAYS,
    HISTORY_RETENTION_DAYS,
    formatAztec,
    projectAddressStatus,
    type Network,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import type { SequencerState } from '@/lib/sequencerState';
import { stakeOutlook, type StakeOutlook } from '@/lib/stakeOutlook';
import { CopyButton } from './CopyButton';
import { SequencerHistory } from './SequencerHistory';
import { SequencerLink } from './SequencerLink';

export type SequencerHistoryLoader = (
    address: string,
    signal: AbortSignal,
) => Promise<SlashingCase[]>;

export function AddressStatus({
    address,
    network,
    cases,
    sequencerState,
    sequencerStateLoading,
    protocol,
    selectedCaseId,
    archiveNote,
    loadHistory,
    autoLoadHistory = false,
    fullHistoryHref,
    onOpenProtocolGuide,
}: {
    address: string;
    network: Network;
    cases: SlashingCase[];
    sequencerState: SequencerState | null;
    sequencerStateLoading: boolean;
    protocol: ProtocolSnapshot | null;
    selectedCaseId: string | null;
    archiveNote?: string;
    // Fetches the older history a watchlist response omits.
    loadHistory?: SequencerHistoryLoader;
    autoLoadHistory?: boolean;
    // Where a source without full history sends the viewer for it.
    fullHistoryHref?: string;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const history = useFullHistory(address, loadHistory, autoLoadHistory);
    // The polled cases are fresher than a one-off history read.
    const allCases = [...new Map(
        [...history.cases, ...cases].map((item) => [item.id, item]),
    ).values()];
    const status = projectAddressStatus(address, allCases);
    const summary = summarizeSequencer(
        allCases,
        sequencerState?.effectiveBalance.toString() ?? null,
    );
    const outlook = sequencerState ? stakeOutlook(sequencerState, protocol) : null;
    const threshold = protocol?.staking?.localEjectionThreshold ?? null;
    const openCount = summary.activeCases;

    return (
        <section className="border-6 border-chartreuse bg-malachite p-4 shadow-brutal-chartreuse sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <p className="text-xs font-black uppercase text-chartreuse">Sequencer</p>
                    <div className="mt-1 flex min-w-0 items-center gap-2">
                        <SequencerLink
                            address={address}
                            network={network}
                            className="text-sm text-whisper-white sm:text-base"
                        />
                        <CopyButton value={address} />
                    </div>
                    <h2 className="mt-4 text-2xl font-black text-whisper-white">
                        {status.headline}
                    </h2>
                </div>
                <span className={`w-fit border-3 border-brand-black px-3 py-2 text-xs font-black uppercase text-brand-black ${
                    openCount === 0
                        ? 'bg-chartreuse'
                        : status.urgency === 'critical'
                            ? 'bg-vermillion'
                            : status.urgency === 'warning'
                                ? 'bg-orchid'
                                : 'bg-aqua'
                }`}>
                    {openCount > 0 ? `${openCount} open` : 'No open cases'}
                </span>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
                <SummaryFact
                    label="Current stake"
                    value={outlook
                        ? `${formatAztec(outlook.stake)} AZTEC`
                        : sequencerStateLoading ? 'Loading…' : 'Not available'}
                    note={outlook?.status}
                />
                <SummaryFact
                    label="Ejected below"
                    value={threshold ? `${formatAztec(threshold)} AZTEC` : '—'}
                    note={threshold ? 'Rollup ejection threshold' : undefined}
                />
                <SummaryFact
                    label="Open cases"
                    value={String(openCount)}
                    note={summary.pendingAmount
                        ? `${formatAztec(summary.pendingAmount)} AZTEC pending`
                        : undefined}
                />
                <SummaryFact label="Stake removed" value={amount(summary.removedAmount)} />
            </dl>
            {outlook && <StakeOutlookNote outlook={outlook} />}

            {allCases.length === 0 ? (
                <p className="mt-4 border-3 border-aqua bg-lapis p-4 text-sm font-bold text-whisper-white/80">
                    No recent slashing evidence is linked to this address.
                    {archiveNote && ` ${archiveNote}`}
                    {fullHistoryHref && <> <FullHistoryLink href={fullHistoryHref} /></>}
                </p>
            ) : (
                <SequencerHistory
                    cases={allCases}
                    protocol={protocol}
                    selectedCaseId={selectedCaseId}
                    onOpenProtocolGuide={onOpenProtocolGuide}
                    footer={(
                        <HistoryFooter
                            history={history}
                            archiveNote={archiveNote}
                            fullHistoryHref={fullHistoryHref}
                        />
                    )}
                />
            )}
        </section>
    );
}

function StakeOutlookNote({ outlook }: { outlook: StakeOutlook }) {
    const tone = {
        ok: 'border-chartreuse',
        warning: 'border-orchid',
        critical: 'border-vermillion',
        neutral: 'border-whisper-white/30',
    }[outlook.tone];
    return (
        <p className={`mt-2 border-3 bg-brand-black p-3 text-sm font-bold text-whisper-white/80 ${tone}`}>
            {outlook.detail}
        </p>
    );
}

type FullHistory = ReturnType<typeof useFullHistory>;

function FullHistoryLink({ href }: { href: string }) {
    return (
        <a
            href={href}
            className="font-black uppercase text-aqua underline decoration-2 underline-offset-4 hover:text-chartreuse"
        >
            Full history in PINGME →
        </a>
    );
}

function HistoryFooter({
    history,
    archiveNote,
    fullHistoryHref,
}: {
    history: FullHistory;
    archiveNote?: string;
    fullHistoryHref?: string;
}) {
    const text = {
        unavailable: archiveNote ?? null,
        idle: `Showing every slash, plus other evidence from the last ${CLOSED_CASE_RETENTION_DAYS} days.`,
        loading: `Loading the ${HISTORY_RETENTION_DAYS}-day history…`,
        loaded: `Showing everything PINGME keeps: every slash, and other evidence from the last ${HISTORY_RETENTION_DAYS} days.`,
        error: `The ${HISTORY_RETENTION_DAYS}-day history could not be loaded.`,
    }[history.status];
    if (!text && !fullHistoryHref) return null;
    return (
        <p className="mt-3 text-xs font-bold text-whisper-white/60">
            {text}
            {history.status === 'unavailable' && fullHistoryHref && (
                <>{text && ' '}<FullHistoryLink href={fullHistoryHref} /></>
            )}
            {(history.status === 'idle' || history.status === 'error') && (
                <>
                    {' '}
                    <button
                        type="button"
                        onClick={history.request}
                        className="min-h-11 font-black uppercase text-aqua underline decoration-2 underline-offset-4 hover:text-chartreuse"
                    >
                        {history.status === 'error'
                            ? 'Retry'
                            : `Load ${HISTORY_RETENTION_DAYS}-day history`}
                    </button>
                </>
            )}
        </p>
    );
}

function useFullHistory(
    address: string,
    load: SequencerHistoryLoader | undefined,
    autoLoad: boolean,
) {
    const [attempt, setAttempt] = useState(autoLoad ? 1 : 0);
    const [result, setResult] = useState<{
        key: string;
        cases: SlashingCase[] | null;
    } | null>(null);
    const key = `${address.toLowerCase()}:${attempt}`;

    useEffect(() => {
        if (!load || attempt === 0) return;
        const controller = new AbortController();
        load(address, controller.signal).then(
            (cases) => setResult({ key, cases }),
            () => {
                if (!controller.signal.aborted) setResult({ key, cases: null });
            },
        );
        return () => controller.abort();
    }, [address, attempt, key, load]);

    const current = result?.key === key ? result : null;
    const status = !load
        ? 'unavailable'
        : attempt === 0
            ? 'idle'
            : !current
                ? 'loading'
                : current.cases ? 'loaded' : 'error';
    return {
        status,
        cases: current?.cases ?? [],
        request: () => setAttempt((value) => value + 1),
    } as const;
}

export function summarizeSequencer(
    cases: readonly SlashingCase[],
    currentStake: string | null,
): {
    activeCases: number;
    pendingAmount: string | null;
    removedAmount: string | null;
    currentStake: string | null;
} {
    const pendingAmount = sumAmounts(cases
        .filter((item) => item.state.active)
        .map((item) => item.state.requestedAmount));
    const removedAmount = sumAmounts(cases.map((item) => item.state.actualAmount));
    return {
        activeCases: cases.filter((item) => item.state.active).length,
        pendingAmount,
        removedAmount,
        currentStake: readAmount(currentStake),
    };
}

function SummaryFact({
    label,
    value,
    note,
}: {
    label: string;
    value: string;
    note?: string;
}) {
    return (
        <div className="border-3 border-chartreuse bg-brand-black p-2">
            <dt className="text-[0.65rem] font-black uppercase text-chartreuse">{label}</dt>
            <dd className="mt-1 break-words text-sm font-black text-whisper-white">{value}</dd>
            {note && (
                <dd className="mt-0.5 text-[0.65rem] font-bold uppercase text-whisper-white/55">
                    {note}
                </dd>
            )}
        </div>
    );
}

function amount(value: string | null): string {
    return value === null ? '—' : `${formatAztec(value)} AZTEC`;
}

function sumAmounts(values: Array<string | null>): string | null {
    const amounts = values
        .map(readAmount)
        .filter((value): value is string => value !== null);
    if (amounts.length === 0) return null;
    return amounts
        .reduce((total, value) => total + BigInt(value), 0n)
        .toString();
}

function readAmount(value: unknown): string | null {
    return typeof value === 'string' && /^\d+$/.test(value)
        ? value
        : null;
}
