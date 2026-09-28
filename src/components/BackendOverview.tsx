import { useEffect, useState } from 'react';
import { CaseSurface } from './CaseSurface';
import { NetworkHealth } from './NetworkHealth';
import { SourceStatus } from './SourceStatus';
import { WatchSettings } from './WatchSettings';
import { backendApi } from '@/api/client';
import { useBackendMonitor } from '@/hooks/useBackendMonitor';
import { useSequencerStates } from '@/hooks/useSequencerStates';
import type { MonitorNetwork } from '@/types/backendApi';
import type { MonitorConfigInput } from '@/types/slashing';
import {
    CLOSED_CASE_RETENTION_DAYS,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';

const ARCHIVE_NOTE = `PINGME keeps closed cases that never reached quorum for ` +
    `${CLOSED_CASE_RETENTION_DAYS} days after their last evidence.`;

export function BackendOverview({
    network,
    configInput,
    selectedCaseId,
    onOpenMonitor,
    linkedAddresses,
    onWatchlistChange,
    onOpenProtocolGuide,
    onProtocolChange,
}: {
    network: MonitorNetwork;
    configInput: MonitorConfigInput;
    selectedCaseId: string | null;
    onOpenMonitor: () => void;
    linkedAddresses: string[];
    onWatchlistChange: (addresses: readonly string[]) => void;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
    onProtocolChange: (protocol: ProtocolSnapshot | null) => void;
}) {
    const monitor = useBackendMonitor(network, linkedAddresses);
    const liveProtocol = monitor.error
        ? null
        : monitor.status?.protocol ?? null;
    const watchedAddresses = linkedAddresses.length > 0
        ? linkedAddresses
        : monitor.watch?.addresses ?? [];
    const sequencerStates = useSequencerStates({
        config: configInput,
        protocol: liveProtocol,
        addresses: watchedAddresses,
    });

    const loadedCases = monitor.networkData
        ? mergeCases(monitor.networkData.cases, monitor.watchedCases)
        : undefined;
    const linkedCase = useCaseOutsideFeed(selectedCaseId, loadedCases);

    useEffect(() => {
        onProtocolChange(liveProtocol);
    }, [liveProtocol, onProtocolChange]);

    if (monitor.error || (!monitor.isLoading && !monitor.networkData)) {
        return (
            <section className="border-6 border-vermillion bg-oxblood p-6 shadow-brutal-vermillion sm:p-8" role="alert">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-vermillion">
                    PINGME unavailable
                </p>
                <h2 className="mt-2 text-3xl font-black text-whisper-white">
                    No current evidence
                </h2>
                <p className="mt-4 max-w-3xl break-words text-sm font-bold text-whisper-white/80">
                    {monitor.error ?? 'No current backend snapshot is available.'}
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                    <button type="button" onClick={onOpenMonitor} className="brutal-button">
                        Open independent L1 Monitor
                    </button>
                    <button
                        type="button"
                        onClick={() => void monitor.refresh()}
                        className="brutal-button brutal-button--neutral"
                    >
                        Retry PINGME
                    </button>
                </div>
            </section>
        );
    }

    if (monitor.isLoading || !monitor.networkData) {
        return (
            <div className="mx-auto max-w-2xl border-5 border-chartreuse bg-brand-black p-8 text-center shadow-brutal-chartreuse">
                <div className="mx-auto mb-4 h-14 w-14 animate-spin border-5 border-chartreuse border-t-transparent" />
                <p className="font-black uppercase tracking-wider text-chartreuse">
                    Loading current cases…
                </p>
            </div>
        );
    }

    const protocol = monitor.status?.protocol ?? null;
    const degraded = monitor.status?.status !== 'healthy' ||
        monitor.status.sources.some((source) => source.status !== 'healthy');

    return (
        <>
            {degraded && (
                <section className="mb-8 border-5 border-vermillion bg-oxblood p-5 shadow-brutal-vermillion" role="status">
                    <h2 className="text-2xl font-black text-vermillion">
                        PINGME evidence is incomplete or stale
                    </h2>
                    <p className="mt-2 text-sm font-bold text-whisper-white/80">
                        Inspect source status below. For an independent canonical L1 view,
                        use Monitor with your own public RPC.
                    </p>
                    <button type="button" onClick={onOpenMonitor} className="brutal-button mt-4">
                        Open Monitor
                    </button>
                </section>
            )}
            {monitor.watchError && (
                <section className="mb-8 border-5 border-orchid bg-aubergine p-4 shadow-brutal-orchid" role="status">
                    <h2 className="text-xl font-black text-orchid">
                        Your saved watch could not be loaded
                    </h2>
                    <p className="mt-2 break-words text-sm font-bold text-whisper-white/75">
                        {monitor.watchError} The public network feed remains available;
                        notification settings may need to be recreated.
                    </p>
                </section>
            )}

            <NetworkHealth
                summary={monitor.networkData.summary}
                protocol={protocol}
            />

            <CaseSurface
                network={network}
                cases={linkedCase
                    ? [...loadedCases ?? [], linkedCase]
                    : loadedCases ?? []}
                protocol={protocol}
                watchedAddresses={watchedAddresses}
                sequencerStates={sequencerStates}
                selectedCaseId={selectedCaseId}
                archiveNote={ARCHIVE_NOTE}
                onOpenProtocolGuide={onOpenProtocolGuide}
            >
                <WatchSettings
                    network={network}
                    config={monitor.config}
                    linkedAddresses={linkedAddresses}
                    onWatchlistChange={onWatchlistChange}
                />
            </CaseSurface>

            <SourceStatus sources={monitor.status?.sources ?? []} />
        </>
    );
}

// The feed and the watched history overlap on the watched sequencers' open
// cases and recent outcomes; each case is kept once.
function mergeCases(
    ...lists: ReadonlyArray<readonly SlashingCase[]>
): SlashingCase[] {
    return [...new Map(lists.flat().map((item) => [item.id, item])).values()];
}

// A case link, such as one in an old alert, can outlive the case's place in
// the network feed. Such a case is fetched on its own.
function useCaseOutsideFeed(
    caseId: string | null,
    feed: readonly SlashingCase[] | undefined,
): SlashingCase | null {
    const missingId = caseId && feed && !feed.some((item) => item.id === caseId)
        ? caseId
        : null;
    const [loaded, setLoaded] = useState<SlashingCase | null>(null);

    useEffect(() => {
        if (!missingId) return;
        const controller = new AbortController();
        backendApi.getCase(missingId, controller.signal).then(
            setLoaded,
            () => undefined,
        );
        return () => controller.abort();
    }, [missingId]);

    return loaded?.id === missingId ? loaded : null;
}
