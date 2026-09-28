import { useState } from 'react';
import {
    projectAddressStatus,
    type Network,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import { formatAztec } from '@shared/protocol/index.ts';
import { CaseTimeline } from './CaseTimeline';
import { CopyButton } from './CopyButton';
import { SequencerLink } from './SequencerLink';

export function AddressStatus({
    address,
    network,
    cases,
    currentStake,
    currentStakeLoading,
    protocol,
    selectedCaseId,
    archiveNote,
    onOpenProtocolGuide,
}: {
    address: string;
    network: Network;
    cases: SlashingCase[];
    currentStake: string | null;
    currentStakeLoading: boolean;
    protocol: ProtocolSnapshot | null;
    selectedCaseId: string | null;
    archiveNote?: string;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const status = projectAddressStatus(address, cases);
    const summary = summarizeSequencer(cases, currentStake);
    const open = status.cases.filter((item) => item.state.active);
    const closed = status.cases.filter((item) => !item.state.active);
    const groupProps = { protocol, selectedCaseId, onOpenProtocolGuide };

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
                    open.length === 0
                        ? 'bg-chartreuse'
                        : status.urgency === 'critical'
                            ? 'bg-vermillion'
                            : status.urgency === 'warning'
                                ? 'bg-orchid'
                                : 'bg-aqua'
                }`}>
                    {open.length > 0 ? `${open.length} open` : 'Clear'}
                </span>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
                <SummaryFact label="Open cases" value={String(summary.activeCases)} />
                <SummaryFact label="Pending penalties" value={amount(summary.pendingAmount)} />
                <SummaryFact label="Stake removed" value={amount(summary.removedAmount)} />
                <SummaryFact
                    label="Current stake"
                    value={summary.currentStake === null
                        ? currentStakeLoading ? 'Loading…' : 'Not available'
                        : `${formatAztec(summary.currentStake)} AZTEC`}
                />
            </dl>

            {status.cases.length === 0 ? (
                <p className="mt-4 border-3 border-aqua bg-lapis p-4 text-sm font-bold text-whisper-white/80">
                    No recent slashing evidence is linked to this address.
                    {archiveNote && ` ${archiveNote}`}
                </p>
            ) : (
                <>
                    {open.length > 0 && (
                        <CaseGroup title="Open cases" cases={open} {...groupProps} />
                    )}
                    {closed.length > 0 && (
                        <CaseGroup
                            title="Closed cases"
                            note={['These cases are final.', archiveNote]
                                .filter(Boolean)
                                .join(' ')}
                            cases={closed}
                            {...groupProps}
                        />
                    )}
                </>
            )}
        </section>
    );
}

function CaseGroup({
    title,
    note,
    cases,
    protocol,
    selectedCaseId,
    onOpenProtocolGuide,
}: {
    title: string;
    note?: string;
    cases: SlashingCase[];
    protocol: ProtocolSnapshot | null;
    selectedCaseId: string | null;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const containsSelectedCase = selectedCaseId !== null &&
        cases.some((item) => item.id === selectedCaseId);
    const [expanded, setExpanded] = useState(false);
    const isExpanded = containsSelectedCase || expanded;

    return (
        <details
            open={isExpanded}
            onToggle={(event) => {
                if (!containsSelectedCase) {
                    setExpanded(event.currentTarget.open);
                }
            }}
            className="mt-4 border-t-3 border-chartreuse pt-3"
        >
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-black uppercase text-chartreuse">
                <span>{title}</span>
                <span className="text-xs text-whisper-white/60">
                    {isExpanded ? 'Hide' : 'Open'} · {cases.length} case{cases.length === 1 ? '' : 's'}
                </span>
            </summary>
            {note && (
                <p className="mt-2 text-xs font-bold text-whisper-white/60">{note}</p>
            )}
            <div className="mt-4 grid gap-6">
                {cases.map((item) => (
                    <CaseTimeline
                        key={item.id}
                        item={item}
                        protocol={protocol}
                        selected={selectedCaseId === item.id}
                        onOpenProtocolGuide={onOpenProtocolGuide}
                    />
                ))}
            </div>
        </details>
    );
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

function SummaryFact({ label, value }: { label: string; value: string }) {
    return (
        <div className="border-3 border-chartreuse bg-brand-black p-2">
            <dt className="text-[0.65rem] font-black uppercase text-chartreuse">{label}</dt>
            <dd className="mt-1 break-words text-sm font-black text-whisper-white">{value}</dd>
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
