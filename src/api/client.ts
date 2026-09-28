import type { WebPushSubscriptionJson } from '@/lib/push';
import type {
    BackendConfig,
    BackendStatus,
    CreatedWatch,
    ManagedWatch,
    NetworkCases,
    SequencerCases,
    SlashingCase,
    TelegramLink,
} from '@/types/backendApi';

const REQUEST_TIMEOUT_MS = 12_000;
const API_ROOT = '/api';

export class BackendApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string | null,
    ) {
        super(message);
        this.name = 'BackendApiError';
    }
}

export class BackendApiClient {
    private readonly baseUrl: string;

    constructor(baseUrl = import.meta.env.VITE_API_BASE_URL ?? '') {
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    getConfig(signal?: AbortSignal): Promise<BackendConfig> {
        return this.request('/config', { signal }) as Promise<BackendConfig>;
    }

    getStatus(signal?: AbortSignal): Promise<BackendStatus> {
        return this.request('/status', { signal }) as Promise<BackendStatus>;
    }

    getNetwork(signal?: AbortSignal): Promise<NetworkCases> {
        return this.request('/network', { signal }) as Promise<NetworkCases>;
    }

    getSequencerCases(
        addresses: readonly string[],
        signal?: AbortSignal,
    ): Promise<SequencerCases> {
        const query = encodeURIComponent(addresses.join(','));
        return this.request(`/sequencers?addresses=${query}`, { signal }) as
            Promise<SequencerCases>;
    }

    getCase(id: string, signal?: AbortSignal): Promise<SlashingCase> {
        return this.request(`/cases/${encodeURIComponent(id)}`, { signal }) as
            Promise<SlashingCase>;
    }

    createWatch(network: string, addresses: readonly string[]): Promise<CreatedWatch> {
        return this.request('/watches', {
            method: 'POST',
            body: { network, addresses },
        }) as Promise<CreatedWatch>;
    }

    getWatch(id: string, token: string, signal?: AbortSignal): Promise<ManagedWatch> {
        return this.request(`/watches/${encodeURIComponent(id)}`, {
            token,
            signal,
        }) as Promise<ManagedWatch>;
    }

    updateWatch(
        id: string,
        token: string,
        addresses: readonly string[],
    ): Promise<ManagedWatch> {
        return this.request(`/watches/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            token,
            body: { addresses },
        }) as Promise<ManagedWatch>;
    }

    async deleteWatch(id: string, token: string): Promise<void> {
        await this.request(`/watches/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            token,
        });
    }

    setWebPush(
        id: string,
        token: string,
        subscription: WebPushSubscriptionJson,
    ): Promise<ManagedWatch> {
        return this.request(
            `/watches/${encodeURIComponent(id)}/channels/web_push`,
            { method: 'PUT', token, body: { subscription } },
        ) as Promise<ManagedWatch>;
    }

    async deleteWebPush(id: string, token: string): Promise<void> {
        await this.request(
            `/watches/${encodeURIComponent(id)}/channels/web_push`,
            { method: 'DELETE', token },
        );
    }

    createTelegramLink(id: string, token: string): Promise<TelegramLink> {
        return this.request(
            `/watches/${encodeURIComponent(id)}/channels/telegram-link`,
            { method: 'POST', token, body: {} },
        ) as Promise<TelegramLink>;
    }

    async sendTest(id: string, token: string): Promise<void> {
        await this.request(`/watches/${encodeURIComponent(id)}/channels/test`, {
            method: 'POST',
            token,
            body: {},
        });
    }

    private async request(path: string, options: {
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        token?: string;
        body?: Record<string, unknown>;
        signal?: AbortSignal;
    } = {}): Promise<unknown> {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = options.signal
            ? AbortSignal.any([options.signal, timeout])
            : timeout;
        const headers = new Headers({ accept: 'application/json' });
        if (options.body) headers.set('content-type', 'application/json');
        if (options.token) headers.set('authorization', `Bearer ${options.token}`);
        try {
            const response = await fetch(`${this.baseUrl}${API_ROOT}${path}`, {
                method: options.method ?? 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal,
                // no-cache (not no-store) lets the browser revalidate with
                // If-None-Match, so unchanged polls cost a bodyless 304.
                cache: 'no-cache',
            });
            const text = await response.text();
            const payload: unknown = text ? parseJson(text) : null;
            if (!response.ok) {
                const apiError = readApiError(payload);
                throw new BackendApiError(
                    apiError.message ??
                        `slashveto.me API request failed with HTTP ${response.status}`,
                    response.status,
                    apiError.code,
                );
            }
            return payload;
        }
        catch (error) {
            if (error instanceof BackendApiError) throw error;
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw new Error(options.signal?.aborted
                    ? 'slashveto.me API request was cancelled'
                    : 'slashveto.me API did not respond in time', { cause: error });
            }
            throw error;
        }
    }
}

export const backendApi = new BackendApiClient();

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    }
    catch {
        throw new BackendApiError(
            'slashveto.me API returned invalid JSON',
            502,
            'invalid_json',
        );
    }
}

function readApiError(value: unknown): { code: string | null; message: string | null } {
    if (!isRecord(value) || !isRecord(value.error)) {
        return { code: null, message: null };
    }
    return {
        code: typeof value.error.code === 'string' ? value.error.code : null,
        message: typeof value.error.message === 'string' ? value.error.message : null,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
