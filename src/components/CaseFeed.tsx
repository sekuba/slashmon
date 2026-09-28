import { useState } from 'react';
import {
    formatAztec,
    selectCaseFeed,
    stageLabel,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import {
    groupCasesByPayload,
    type CasePayloadGroup,
} from '@/lib/caseFeed';
import { CaseTimeline } from './CaseTimeline';

export function CaseFeed({
    cases,
    protocol,
    selectedCaseId,
    onOpenProtocolGuide,
}: {
    cases: SlashingCase[];
    protocol: ProtocolSnapshot | null;
    selectedCaseId: string | null;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const feed = selectCaseFeed(cases);
    const activeGroups = groupCasesByPayload(feed.active);
    const recentGroups = groupCasesByPayload(feed.recentlyExecuted);
    const roundProgress = currentRoundProgress(protocol);
    const count = feed.active.length;

    return (
        <section id="case-feed" className="mb-10 scroll-mt-4">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h2 className="text-3xl font-black text-whisper-white">
                        Case feed
                    </h2>
                </div>
                <div className="w-full sm:w-auto sm:min-w-72">
                    <span className="block w-fit border-3 border-brand-black bg-vermillion px-3 py-2 text-sm font-black uppercase text-brand-black sm:ml-auto">
                        {count} active
                    </span>
                    {roundProgress && (
                        <RoundProgress progress={roundProgress} />
                    )}
                </div>
            </div>

            {activeGroups.length > 0 ? (
                <div className="grid gap-4">
                    {activeGroups.map((group) => (
                        <PayloadCaseGroup
                            key={group.id}
                            group={group}
                            protocol={protocol}
                            selectedCaseId={selectedCaseId}
                            onOpenProtocolGuide={onOpenProtocolGuide}
                        />
                    ))}
                </div>
            ) : (
                <div className="border-5 border-chartreuse bg-malachite p-6 shadow-brutal-chartreuse">
                    <h3 className="text-xl font-black text-chartreuse">No active cases</h3>
                    <p className="mt-2 text-sm font-bold text-whisper-white/70">
                        No open slashing cases are visible from the current sources.
                    </p>
                </div>
            )}

            {feed.recentlyExecuted.length > 0 && (
                <div className="mt-8">
                    <h3 className="mb-4 text-xl font-black text-aqua">
                        Recent execution outcomes
                    </h3>
                    <div className="grid gap-4">
                        {recentGroups.map((group) => (
                            <PayloadCaseGroup
                                key={group.id}
                                group={group}
                                protocol={protocol}
                                selectedCaseId={selectedCaseId}
                                onOpenProtocolGuide={onOpenProtocolGuide}
                            />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}

function PayloadCaseGroup({
    group,
    protocol,
    selectedCaseId,
    onOpenProtocolGuide,
}: {
    group: CasePayloadGroup;
    protocol: ProtocolSnapshot | null;
    selectedCaseId: string | null;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const containsSelectedCase = selectedCaseId !== null &&
        group.cases.some((item) => item.id === selectedCaseId);
    const [expanded, setExpanded] = useState(false);
    const isExpanded = containsSelectedCase || expanded;
    const primary = group.cases[0];
    const sequencerCount = new Set(group.cases.map((item) => item.sequencer)).size;
    const requestedAmount = group.cases.reduce<bigint | null>((sum, item) => {
        const amount = item.state.requestedAmount;
        if (!amount || !/^\d+$/.test(amount)) return sum;
        return (sum ?? 0n) + BigInt(amount);
    }, null);

    return (
        <details
            open={isExpanded}
            onToggle={(event) => {
                if (!containsSelectedCase) {
                    setExpanded(event.currentTarget.open);
                }
            }}
            className={`border-5 bg-brand-black ${
                primary.state.urgency === 'critical'
                    ? 'border-vermillion shadow-brutal-vermillion'
                    : primary.state.urgency === 'warning'
                        ? 'border-orchid shadow-brutal-orchid'
                        : 'border-aqua shadow-brutal-aqua'
            }`}
        >
            <summary className="min-h-16 cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <p className="text-xs font-black uppercase tracking-[0.14em] text-aqua">
                            {group.payloadAddress
                                ? `Payload${group.round ? ` · round ${group.round}` : ''} · ${stageLabel(primary.state.stage)}`
                                : `No L1 payload yet · epoch ${primary.targetEpoch}`}
                        </p>
                        <h4 className="mt-1 break-all text-lg font-black text-whisper-white">
                            {group.payloadAddress
                                ? `${sequencerCount} sequencer${sequencerCount === 1 ? '' : 's'} targeted${
                                    requestedAmount !== null
                                        ? ` · ${formatAztec(requestedAmount)} AZTEC`
                                        : ''
                                }`
                                : primary.state.headline}
                        </h4>
                        <p className="mt-1 text-xs font-bold text-whisper-white/60">
                            {group.payloadAddress ? (
                                <>
                                    <span className="break-all">{group.payloadAddress}</span>
                                    {' · '}{group.cases.length} case
                                    {group.cases.length === 1 ? '' : 's'}
                                </>
                            ) : (
                                <>
                                    {sequencerCount} sequencer
                                    {sequencerCount === 1 ? '' : 's'}
                                    {' · '}{group.cases.length} case
                                    {group.cases.length === 1 ? '' : 's'}
                                    {' · '}{stageLabel(primary.state.stage)}
                                </>
                            )}
                        </p>
                    </div>
                    <span className="w-fit border-3 border-aqua bg-lapis px-3 py-2 text-xs font-black uppercase text-aqua">
                        {isExpanded ? 'Hide' : 'Open'}
                    </span>
                </div>
            </summary>
            <div className="grid gap-5 border-t-3 border-whisper-white/25 p-4 sm:p-5">
                {group.cases.map((item) => (
                    <CaseTimeline
                        key={item.id}
                        item={item}
                        protocol={protocol}
                        selected={selectedCaseId === item.id}
                        showSequencer
                        onOpenProtocolGuide={onOpenProtocolGuide}
                    />
                ))}
            </div>
        </details>
    );
}

interface RoundProgressValue {
    round: string;
    epoch: string;
    epochPosition: number;
    epochsPerRound: number;
    slotPosition: number;
    slotsPerEpoch: number;
    percentage: number;
}

function RoundProgress({ progress }: { progress: RoundProgressValue }) {
    return (
        <div className="mt-2 border-3 border-aqua bg-lapis p-3">
            <div className="flex items-center justify-between gap-3 text-xs font-black uppercase text-aqua">
                <span>Current round {progress.round}</span>
                <span>Epoch {progress.epochPosition}/{progress.epochsPerRound}</span>
            </div>
            <div
                role="progressbar"
                aria-label={`Progress of epoch ${progress.epoch}`}
                aria-valuemin={0}
                aria-valuemax={progress.slotsPerEpoch}
                aria-valuenow={progress.slotPosition}
                className="mt-2 h-4 border-3 border-aqua bg-brand-black"
            >
                <div
                    className="h-full bg-aqua"
                    style={{ width: `${progress.percentage}%` }}
                />
            </div>
            <p className="mt-1 text-[0.65rem] font-bold text-whisper-white/55">
                Epoch {progress.epoch} · slot {progress.slotPosition} of {progress.slotsPerEpoch}
            </p>
        </div>
    );
}

export function currentRoundProgress(
    protocol: ProtocolSnapshot | null,
): RoundProgressValue | null {
    const lineage = protocol?.lineages.find((item) => item.role === 'active') ??
        protocol?.lineages[0];
    if (
        !protocol ||
        !lineage ||
        protocol.epochDurationSlots <= 0 ||
        lineage.parameters.roundSizeSlots <= 0 ||
        lineage.parameters.roundSizeEpochs <= 0
    ) {
        return null;
    }
    const currentSlot = BigInt(protocol.currentSlot);
    const slotsPerEpoch = BigInt(protocol.epochDurationSlots);
    const roundSizeSlots = BigInt(lineage.parameters.roundSizeSlots);
    const slotInRound = currentSlot % roundSizeSlots;
    const epochPosition = Math.min(
        lineage.parameters.roundSizeEpochs,
        Number(slotInRound / slotsPerEpoch) + 1,
    );
    const slotPosition = Number(currentSlot % slotsPerEpoch) + 1;
    return {
        round: lineage.currentRound,
        epoch: protocol.currentEpoch,
        epochPosition,
        epochsPerRound: lineage.parameters.roundSizeEpochs,
        slotPosition,
        slotsPerEpoch: protocol.epochDurationSlots,
        percentage: Math.min(100, slotPosition / protocol.epochDurationSlots * 100),
    };
}
