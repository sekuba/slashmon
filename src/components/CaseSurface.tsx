import type { ReactNode } from 'react';
import { AddressStatus, type SequencerHistoryLoader } from './AddressStatus';
import { CaseFeed } from './CaseFeed';
import { CaseTimeline } from './CaseTimeline';
import { WatchlistSection } from './WatchlistSection';
import type { SequencerStates } from '@/hooks/useSequencerStates';
import type { MonitorNetwork } from '@/types/backendApi';
import {
    selectCaseFeed,
    type ProtocolSnapshot,
    type SlashingCase,
} from '@shared/protocol/index.ts';

// The case blocks both surfaces share: a shared/deep-linked case that is not
// otherwise visible, the per-address watchlist, and the network case feed.
// `children` renders between the shared case and the watchlist,
// `archiveNote` explains how long the source keeps closed cases, and
// `loadSequencerHistory` fetches the older history a source can add.
// A short watchlist loads it at once; a long one on request.
const AUTO_HISTORY_ADDRESSES = 3;

export function CaseSurface({
    network,
    cases,
    protocol,
    watchedAddresses,
    sequencerStates,
    selectedCaseId,
    archiveNote,
    loadSequencerHistory,
    fullHistoryHref,
    onOpenProtocolGuide,
    children,
}: {
    network: MonitorNetwork;
    cases: SlashingCase[];
    protocol: ProtocolSnapshot | null;
    watchedAddresses: readonly string[];
    sequencerStates: SequencerStates;
    selectedCaseId: string | null;
    archiveNote?: string;
    loadSequencerHistory?: SequencerHistoryLoader;
    fullHistoryHref?: (address: string) => string;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
    children?: ReactNode;
}) {
    const watchedSet = new Set(watchedAddresses.map((address) => address.toLowerCase()));
    const watchedCases = cases.filter((item) => watchedSet.has(item.sequencer));
    const selectedCase = selectedCaseId
        ? cases.find((item) => item.id === selectedCaseId) ?? null
        : null;
    const feedCaseIds = new Set(
        Object.values(selectCaseFeed(cases)).flat().map((item) => item.id),
    );
    const selectedInFeed = selectedCaseId ? feedCaseIds.has(selectedCaseId) : false;
    const selectedInWatchlist = selectedCase
        ? watchedSet.has(selectedCase.sequencer)
        : false;

    return (
        <>
            {selectedCase && !selectedInFeed && !selectedInWatchlist && (
                <section className="mb-8">
                    <p className="mb-3 text-xs font-black uppercase tracking-[0.16em] text-aqua">
                        Shared case
                    </p>
                    <CaseTimeline
                        item={selectedCase}
                        protocol={protocol}
                        selected
                        showSequencer
                        onOpenProtocolGuide={onOpenProtocolGuide}
                    />
                </section>
            )}

            {children}

            {watchedAddresses.length > 0 && (
                <WatchlistSection
                    cases={watchedCases}
                    sequencerCount={watchedAddresses.length}
                    forceOpen={selectedInWatchlist && !selectedInFeed}
                >
                    {watchedAddresses.map((address) => (
                        <AddressStatus
                            key={address}
                            address={address}
                            network={network}
                            cases={watchedCases.filter(
                                (item) => item.sequencer === address.toLowerCase(),
                            )}
                            sequencerState={
                                sequencerStates.states.get(address.toLowerCase()) ?? null
                            }
                            sequencerStateLoading={sequencerStates.isLoading}
                            protocol={protocol}
                            selectedCaseId={selectedInFeed ? null : selectedCaseId}
                            archiveNote={archiveNote}
                            loadHistory={loadSequencerHistory}
                            autoLoadHistory={
                                watchedAddresses.length <= AUTO_HISTORY_ADDRESSES
                            }
                            fullHistoryHref={fullHistoryHref?.(address)}
                            onOpenProtocolGuide={onOpenProtocolGuide}
                        />
                    ))}
                </WatchlistSection>
            )}

            <CaseFeed
                cases={cases}
                protocol={protocol}
                selectedCaseId={selectedCaseId}
                onOpenProtocolGuide={onOpenProtocolGuide}
            />
        </>
    );
}
