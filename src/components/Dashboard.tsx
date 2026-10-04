import { useEffect, useMemo, useState } from 'react';
import { CaseSurface } from './CaseSurface';
import { ExecutionHistoryStatus } from './ExecutionHistoryStatus';
import { MonitorDetails } from './MonitorDetails';
import { NetworkHealth } from './NetworkHealth';
import { SequencerFilter } from './SequencerFilter';
import {
    loadMonitorAddresses,
    saveMonitorAddresses,
} from '@/lib/monitorAddressStorage';
import { projectMonitorCases } from '@/lib/monitorCases';
import { urlForWatchlist } from '@/lib/navigation';
import { summarizeNetwork } from '@shared/protocol/index.ts';
import { useSlashingStore } from '@/store/slashingStore';
import { useSequencerStates } from '@/hooks/useSequencerStates';
import type { MonitorConfigInput } from '@/types/slashing';
import type { ProtocolSnapshot } from '@shared/protocol/index.ts';

// Monitor scans only rounds that can still change, so any slash it shows
// executed recently. PINGME keeps the history and the node evidence.
function monitorNote(protocol: ProtocolSnapshot | null): string {
    const lineage = protocol?.lineages.find((item) => item.role === 'active');
    const days = protocol && lineage
        ? lineage.parameters.lifetimeRounds * lineage.parameters.roundSizeSlots *
            protocol.slotDurationSeconds / 86_400
        : null;
    return `Monitor reads only L1 rounds still within their ${
        days === null ? '' : `${days.toFixed(1)}-day `
    }lifetime, so it shows recent slashes only, without node evidence.`;
}

interface DashboardProps {
    configInput: MonitorConfigInput;
    network: 'mainnet' | 'testnet';
    linkedAddresses: string[];
    selectedCaseId: string | null;
    onResetRpc: () => void;
    onToggleNetwork: () => void;
    onUpdateRpc: (url: string) => void;
    onWatchlistChange: (addresses: readonly string[]) => void;
    onOpenProtocolGuide: (protocol: ProtocolSnapshot | null) => void;
    onProtocolChange: (protocol: ProtocolSnapshot | null) => void;
}

export function Dashboard({
    configInput,
    network,
    linkedAddresses,
    selectedCaseId,
    onResetRpc,
    onToggleNetwork,
    onUpdateRpc,
    onWatchlistChange,
    onOpenProtocolGuide,
    onProtocolChange,
}: DashboardProps) {
    const store = useSlashingStore();
    const [addresses, setAddresses] = useState(() =>
        linkedAddresses.length > 0
            ? linkedAddresses
            : loadMonitorAddresses(network));

    const projected = useMemo(() => {
        if (!store.config || !store.isInitialized) return null;
        return projectMonitorCases({
            network,
            config: store.config,
            state: store,
            slashings: [...store.detectedSlashings.values()],
            confirmedExecutions: store.confirmedExecutions,
            confirmedSlashes: store.confirmedSlashes,
            executionScan: store.executionScan,
        });
    }, [network, store]);
    const sequencerStates = useSequencerStates({
        config: configInput,
        protocol: projected?.protocol ?? null,
        addresses,
    });

    useEffect(() => {
        onProtocolChange(projected?.protocol ?? null);
    }, [onProtocolChange, projected?.protocol]);

    const saveAddresses = (next: string[]) => {
        setAddresses(next);
        saveMonitorAddresses(network, next);
        onWatchlistChange(next);
    };
    const watchlistUrl = addresses.length > 0 && typeof window !== 'undefined'
        ? urlForWatchlist(window.location.href, 'monitor', network, addresses).href
        : null;

    const controls = (
        <div className="mb-8">
            <MonitorDetails
                key={configInput.chainId}
                configInput={configInput}
                network={network}
                onResetRpc={onResetRpc}
                onToggleNetwork={onToggleNetwork}
                onUpdateRpc={onUpdateRpc}
            />
        </div>
    );

    if (!store.isInitialized) {
        return (
            <main className="mx-auto max-w-7xl px-4 py-8">
                {controls}
                <div className={`mx-auto max-w-2xl border-5 p-8 ${
                    store.initializationError
                        ? 'border-vermillion bg-oxblood shadow-brutal-vermillion'
                        : 'border-chartreuse bg-brand-black text-center shadow-brutal-chartreuse'
                }`}>
                    {store.initializationError ? (
                        <>
                            <h1 className="text-2xl font-black text-vermillion">Monitor unavailable</h1>
                            <p className="mt-3 break-words font-bold text-whisper-white">
                                {store.initializationError}
                            </p>
                        </>
                    ) : (
                        <>
                            <div className="mx-auto mb-4 h-16 w-16 animate-spin border-5 border-chartreuse border-t-transparent" />
                            <p className="font-black uppercase tracking-wider text-chartreuse">
                                Verifying the canonical L1 contracts…
                            </p>
                        </>
                    )}
                </div>
            </main>
        );
    }

    return (
        <main className="mx-auto max-w-7xl px-4 py-8">
            {controls}

            {store.audit.status !== 'ok' && (
                <section className="mb-8 border-5 border-vermillion bg-oxblood p-5 shadow-brutal-vermillion">
                    <h2 className="text-xl font-black text-vermillion">L1 evidence may be incomplete</h2>
                    <p className="mt-2 text-sm font-bold text-whisper-white/75">
                        {store.audit.issues[0]?.message ?? 'The latest pinned scan was incomplete.'}
                    </p>
                </section>
            )}

            {projected && (
                <NetworkHealth
                    summary={summarizeNetwork(projected.cases)}
                    protocol={projected.protocol}
                />
            )}

            {['scanning', 'paused'].includes(store.executionScan.status) ? (
                <ExecutionHistoryStatus scan={store.executionScan} />
            ) : store.executionScan.status === 'idle' && store.isScanning && (
                <div className="mb-8 border-5 border-aqua bg-lapis p-5 shadow-brutal-aqua">
                    <p className="font-black uppercase text-aqua">
                        Scanning live and historical slashing rounds…
                    </p>
                </div>
            )}

            <SequencerFilter
                addresses={addresses}
                watchlistUrl={watchlistUrl}
                onSave={saveAddresses}
            />

            {projected && (
                <CaseSurface
                    network={network}
                    cases={projected.cases}
                    protocol={projected.protocol}
                    watchedAddresses={addresses}
                    sequencerStates={sequencerStates}
                    selectedCaseId={selectedCaseId}
                    archiveNote={monitorNote(projected.protocol)}
                    fullHistoryHref={(address) => urlForWatchlist(
                        window.location.href,
                        'pingme',
                        network,
                        [address],
                    ).href}
                    onOpenProtocolGuide={onOpenProtocolGuide}
                />
            )}
        </main>
    );
}
