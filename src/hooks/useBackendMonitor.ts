import { useCallback, useEffect, useRef, useState } from 'react';
import { backendApi } from '@/api/client';
import { loadWatchCredentials, onWatchChanged } from '@/lib/watchStorage';
import type {
    BackendConfig,
    BackendStatus,
    ManagedWatch,
    MonitorNetwork,
    NetworkCases,
    SlashingCase,
} from '@/types/backendApi';

const POLL_INTERVAL_MS = 15_000;

interface State {
    config: BackendConfig | null;
    status: BackendStatus | null;
    networkData: NetworkCases | null;
    watchedCases: SlashingCase[];
    watch: ManagedWatch | null;
    watchError: string | null;
    isLoading: boolean;
    error: string | null;
}

const initialState: State = {
    config: null,
    status: null,
    networkData: null,
    watchedCases: [],
    watch: null,
    watchError: null,
    isLoading: true,
    error: null,
};

// Polls the public network feed and, for the watched sequencers, their full
// retained case history. Linked addresses take precedence over the saved
// watch's addresses, as in the watchlist itself.
export function useBackendMonitor(
    network: MonitorNetwork,
    linkedAddresses: readonly string[],
) {
    // A stable key keeps a re-rendered but unchanged list from restarting polls.
    const linkedKey = [...new Set(linkedAddresses.map((address) =>
        address.toLowerCase()))].sort().join(',');
    const [state, setState] = useState<State>(initialState);
    const abortRef = useRef<AbortController | null>(null);
    const [credentials, setCredentials] = useState(
        () => loadWatchCredentials(network),
    );

    useEffect(() => onWatchChanged(
        network,
        () => setCredentials(loadWatchCredentials(network)),
    ), [network]);

    const refresh = useCallback(async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const watchRequest = credentials
                ? backendApi.getWatch(
                    credentials.id,
                    credentials.managementToken,
                    controller.signal,
                ).then(
                    (watch) => ({ watch, error: null }),
                    (error: unknown) => ({
                        watch: null,
                        error: error instanceof Error
                            ? error.message
                            : 'Unable to load the saved PINGME watch',
                    }),
                )
                : Promise.resolve({ watch: null, error: null });
            const watchedCasesRequest = watchRequest.then(({ watch }) => {
                const addresses = linkedKey
                    ? linkedKey.split(',')
                    : [...watch?.addresses ?? []].sort();
                return addresses.length > 0
                    ? backendApi.getSequencerCases(addresses, controller.signal)
                        .then((result) => result.cases)
                    : [];
            });
            const [config, status, networkData, watchResult, watchedCases] = await Promise.all([
                backendApi.getConfig(controller.signal),
                backendApi.getStatus(controller.signal),
                backendApi.getNetwork(controller.signal),
                watchRequest,
                watchedCasesRequest,
            ]);
            if (controller.signal.aborted) return;
            if (config.network !== network) {
                throw new Error(
                    `This PINGME backend monitors ${config.network}, not ${network}.`,
                );
            }
            setState({
                config,
                status,
                networkData,
                watchedCases,
                watch: watchResult.watch,
                watchError: watchResult.error,
                isLoading: false,
                error: null,
            });
        }
        catch (error) {
            if (controller.signal.aborted) return;
            setState({
                config: null,
                status: null,
                networkData: null,
                watchedCases: [],
                watch: null,
                watchError: null,
                isLoading: false,
                error: error instanceof Error
                    ? error.message
                    : 'Unable to reach the slashveto.me backend',
            });
        }
        finally {
            if (abortRef.current === controller) abortRef.current = null;
        }
    }, [credentials, linkedKey, network]);

    useEffect(() => {
        const initialTimer = window.setTimeout(() => void refresh(), 0);
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void refresh();
        }, POLL_INTERVAL_MS);
        const handleVisible = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        window.addEventListener('online', refresh);
        document.addEventListener('visibilitychange', handleVisible);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(timer);
            window.removeEventListener('online', refresh);
            document.removeEventListener('visibilitychange', handleVisible);
            abortRef.current?.abort();
        };
    }, [refresh]);

    return { ...state, refresh };
}
