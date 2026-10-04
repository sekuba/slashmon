import { useEffect, useRef } from 'react';
import {
    epochStart,
    stageLabel,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';
import { EvidenceDetails } from './EvidenceDetails';
import { urlForCase } from '@/lib/navigation';
import { formatDateTime, relativeTime } from '@/lib/time';
import { ProtocolPath } from './ProtocolPath';
import { SequencerLink } from './SequencerLink';
import { ShareButton } from './ShareButton';

export function CaseTimeline({
    item,
    protocol,
    selected = false,
    showSequencer = false,
    onOpenProtocolGuide,
}: {
    item: SlashingCase;
    protocol: ProtocolSnapshot | null;
    selected?: boolean;
    showSequencer?: boolean;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
}) {
    const ref = useRef<HTMLElement>(null);
    const shareUrl = typeof window === 'undefined'
        ? `?case=${encodeURIComponent(item.id)}`
        : urlForCase(window.location.href, item.id).href;
    useEffect(() => {
        if (selected) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, [selected]);
    const startsAt = epochStart(protocol, item.targetEpoch);

    return (
        <article
            ref={ref}
            id={`case-${safeDomId(item.id)}`}
            className={`border-5 bg-brand-black p-4 sm:p-6 ${
                item.state.urgency === 'critical'
                    ? 'border-vermillion shadow-brutal-vermillion'
                    : item.state.urgency === 'warning'
                        ? 'border-orchid shadow-brutal-orchid'
                        : 'border-aqua shadow-brutal-aqua'
            }`}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="text-xs font-black uppercase tracking-[0.16em] text-aqua">
                            Epoch {item.targetEpoch} · {stageLabel(item.state.stage)}
                        </p>
                        {startsAt && (
                            <time
                                dateTime={startsAt}
                                className="text-xs font-bold text-whisper-white/55"
                                title="When the epoch started"
                            >
                                {formatDateTime(startsAt)}
                            </time>
                        )}
                        <ShareButton url={shareUrl} ariaLabel="Copy link to this case" />
                    </div>
                    {showSequencer && (
                        <SequencerLink
                            address={item.sequencer}
                            network={item.network}
                            className="mt-2 block text-xs text-chartreuse"
                        />
                    )}
                    <h3 className="mt-1 break-words text-xl font-black text-whisper-white sm:text-2xl">
                        {item.state.headline}
                    </h3>
                </div>
                <span className={`w-fit border-3 border-brand-black px-3 py-2 text-xs font-black uppercase text-brand-black ${
                    item.state.urgency === 'critical'
                        ? 'bg-vermillion'
                        : item.state.urgency === 'warning'
                            ? 'bg-orchid'
                            : 'bg-aqua'
                }`}>
                    {item.state.active ? 'Active case' : 'Closed'}
                </span>
            </div>

            <p className="mt-4 text-sm font-bold text-whisper-white/80">
                {item.state.explanation}
            </p>
            <div className="mt-3 border-3 border-chartreuse bg-malachite p-3">
                {item.state.reason.provenance === 'node_evidence' ? (
                    <>
                        <span className="text-xs font-black uppercase text-chartreuse">Reason · </span>
                        <span className="text-sm font-bold text-whisper-white">
                            {item.state.reason.label}
                        </span>
                        <span className="text-xs font-bold text-whisper-white/55">
                            {' '}· from this node’s evidence; L1 votes carry no reason
                        </span>
                    </>
                ) : (
                    <>
                        <span className="text-xs font-black uppercase text-chartreuse">Reason · </span>
                        <span className="text-sm font-bold text-whisper-white">Unknown</span>
                        <span className="text-xs font-bold text-whisper-white/55">
                            {' '}· L1 votes carry no reason, and this source has no node evidence
                        </span>
                    </>
                )}
            </div>

            {item.state.nextTransition && (
                <div className="mt-3 border-3 border-aqua bg-lapis p-3">
                    <p className="text-xs font-black uppercase text-aqua">What happens next</p>
                    <p className="mt-1 font-black text-whisper-white">
                        {item.state.nextTransition.label}
                        {item.state.nextTransition.at
                            ? ` · ${relativeTime(item.state.nextTransition.at)}`
                            : item.state.nextTransition.slot
                                ? ` · slot ${item.state.nextTransition.slot}`
                                : ''}
                    </p>
                </div>
            )}

            <ProtocolPath
                item={item}
                onOpenGuide={() => onOpenProtocolGuide(protocol)}
            />

            <EvidenceDetails item={item} protocol={protocol} />
        </article>
    );
}

function safeDomId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
