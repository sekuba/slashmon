import type { SlashingCase } from './types.ts';

const EXECUTION_OUTCOMES = new Set([
    'executed',
    'stake_removed',
    'ejected',
]);

// How many settled execution outcomes the case feed shows beside every open
// case. The backend sends the network feed already cut to this selection.
export const RECENT_EXECUTION_LIMIT = 4;

export interface CaseFeedSelection {
    active: SlashingCase[];
    recentlyExecuted: SlashingCase[];
}

export function selectCaseFeed(
    cases: readonly SlashingCase[],
    recentExecutionLimit = RECENT_EXECUTION_LIMIT,
): CaseFeedSelection {
    const active = cases
        .filter((item) => item.state.active)
        .sort(byMostRecent);
    const recentlyExecuted = cases
        .filter((item) => !item.state.active && isExecutionOutcome(item))
        .sort((left, right) =>
            executionObservedAt(right).localeCompare(executionObservedAt(left)) ||
            left.id.localeCompare(right.id))
        .slice(0, Math.max(0, recentExecutionLimit));
    return { active, recentlyExecuted };
}

export function byMostRecent(left: SlashingCase, right: SlashingCase): number {
    return right.lastObservedAt.localeCompare(left.lastObservedAt) ||
        left.id.localeCompare(right.id);
}

function isExecutionOutcome(item: SlashingCase): boolean {
    return EXECUTION_OUTCOMES.has(item.state.stage) ||
        item.observations.some((observation) =>
            observation.provenance.canonical &&
            observation.kind === 'l1_round' &&
            (observation.data.isExecuted || observation.data.status === 'executed'));
}

function executionObservedAt(item: SlashingCase): string {
    const canonical = item.observations.filter((observation) =>
        observation.provenance.canonical);
    const slash = [...canonical].reverse().find(
        (observation) => observation.kind === 'l1_slash',
    );
    if (slash) return slash.provenance.observedAt;
    const execution = [...canonical].reverse().find(
        (observation) => observation.kind === 'l1_round' &&
            (observation.data.isExecuted || observation.data.status === 'executed'),
    );
    return execution?.provenance.observedAt ?? item.lastObservedAt;
}
