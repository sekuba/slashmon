import type {
    Network,
    NetworkSummary,
    ProtocolSnapshot,
    SlashingCase,
    SourceStatus,
} from '../../shared/protocol/types.ts';

export type MonitorNetwork = Network;

export interface BackendConfig {
    network: MonitorNetwork;
    maxSequencers: number;
    notifications: {
        webPush: { enabled: boolean; publicKey: string | null };
        telegram: { enabled: boolean; username: string | null };
    };
}

export interface BackendStatus {
    status: 'healthy' | 'degraded' | 'starting';
    network: MonitorNetwork;
    observedAt: string;
    protocol: ProtocolSnapshot | null;
    sources: SourceStatus[];
}

// Every open case and the latest execution outcomes, with a summary of every
// retained case.
export interface NetworkCases {
    summary: NetworkSummary;
    cases: SlashingCase[];
}

// Every retained case of the requested sequencers.
export interface SequencerCases {
    cases: SlashingCase[];
}

export interface NotificationEndpoint {
    id: string;
    kind: 'web_push' | 'telegram';
    enabled: boolean;
    verified: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface ManagedWatch {
    id: string;
    network: MonitorNetwork;
    addresses: string[];
    endpoints: NotificationEndpoint[];
    createdAt: string;
    updatedAt: string;
}

export interface CreatedWatch {
    watch: ManagedWatch;
    managementToken: string;
}

export interface TelegramLink {
    url: string;
    expiresAt: string;
}

export type {
    NetworkSummary,
    ProtocolSnapshot,
    SlashingCase,
    SourceStatus,
};
