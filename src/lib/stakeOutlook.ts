import { formatAztec, type ProtocolSnapshot } from '@shared/protocol/index.ts';
import type { SequencerState } from './sequencerState';
import { formatDateTime } from './time';

export interface StakeOutlook {
    tone: 'ok' | 'warning' | 'critical' | 'neutral';
    status: string;
    stake: bigint;
    detail: string;
}

// What the current stake means for the next slash. The Rollup ejects a
// validator whose stake a slash leaves below the local ejection threshold;
// a stake exactly at the threshold stays.
export function stakeOutlook(
    state: SequencerState,
    protocol: ProtocolSnapshot | null,
    now = Date.now(),
): StakeOutlook {
    const staking = protocol?.staking ?? null;
    const threshold = staking ? BigInt(staking.localEjectionThreshold) : null;
    const amounts = penaltyAmounts(protocol);

    if (state.status === 'zombie' || state.status === 'exiting') {
        const amount = state.exit?.amount ?? 0n;
        // The Rollup stops slashing an exit once it becomes claimable.
        const unlocked = state.exit !== null &&
            Number(state.exit.exitableAt) * 1_000 <= now;
        const claimable = state.exit
            ? unlocked
                ? 'now'
                : `from ${formatDateTime(Number(state.exit.exitableAt) * 1_000)}`
            : null;
        return state.status === 'zombie'
            ? {
                tone: 'critical',
                status: 'Ejected (zombie)',
                stake: amount,
                detail: `Ejected by a slash and no longer validating. ${formatAztec(amount)} AZTEC waits in an exit: ` +
                    'the withdrawer must start the withdrawal' +
                    (claimable ? ` and can claim it ${claimable}` : '') + '.' +
                    (unlocked ? '' : ' Slashes for older epochs can still reduce it until then.'),
            }
            : {
                tone: 'warning',
                status: 'Exiting',
                stake: amount,
                detail: `${formatAztec(amount)} AZTEC is leaving the validator set` +
                    (claimable ? ` and can be claimed ${claimable}` : '') + '.',
            };
    }
    if (state.status === 'none') {
        return {
            tone: 'neutral',
            status: 'Not staked',
            stake: 0n,
            detail: 'This address has no stake on the canonical Rollup.',
        };
    }

    const balance = state.effectiveBalance;
    if (threshold === null) {
        return {
            tone: 'neutral',
            status: 'Validating',
            stake: balance,
            detail: 'The ejection threshold is not available from this source.',
        };
    }
    const headroom = balance - threshold;
    const activation = staking ? BigInt(staking.activationThreshold) : null;
    const reduced = activation !== null && balance < activation
        ? `${formatAztec(activation - balance)} AZTEC below the ${formatAztec(activation)} AZTEC starting stake. `
        : '';
    const absorbable = amounts
        .filter((amount) => amount > 0n)
        .map((amount) => ({ amount, count: headroom < 0n ? 0n : headroom / amount }));
    const smallest = absorbable[0];
    const above = reduced + (headroom >= 0n
        ? `${formatAztec(headroom)} AZTEC above the ${formatAztec(threshold)} AZTEC ejection threshold.`
        : `Below the ${formatAztec(threshold)} AZTEC ejection threshold.`);
    if (!smallest) {
        return {
            tone: headroom > 0n ? 'ok' : 'critical',
            status: 'Validating',
            stake: balance,
            detail: `${above} A slash that leaves less than that ejects it.`,
        };
    }
    if (smallest.count === 0n) {
        return {
            tone: 'critical',
            status: 'Validating',
            stake: balance,
            detail: `${above} The next slash of any size ejects it.`,
        };
    }
    const survivable = absorbable
        .filter(({ count }) => count > 0n)
        .map(({ amount, count }) =>
            `${count} more ${formatAztec(amount)} AZTEC slash${count === 1n ? '' : 'es'}`);
    const fatal = absorbable
        .filter(({ count }) => count === 0n)
        .map(({ amount }) => formatAztec(amount));
    return {
        tone: fatal.length > 0
            ? 'critical'
            : activation !== null && balance < activation ? 'warning' : 'ok',
        status: 'Validating',
        stake: balance,
        detail: `${above} It can take ${joinOr(survivable)} and keep validating; ` +
            (fatal.length > 0
                ? `a ${joinOr(fatal)} AZTEC slash would eject it now.`
                : 'one more after that ejects it.'),
    };
}

// Distinct penalty sizes of the active lineage, smallest first.
export function penaltyAmounts(protocol: ProtocolSnapshot | null): bigint[] {
    const lineage = protocol?.lineages.find((item) => item.role === 'active') ??
        protocol?.lineages[0];
    const amounts = (lineage?.parameters.slashAmounts ?? [])
        .filter((value) => /^\d+$/.test(value))
        .map(BigInt);
    return [...new Set(amounts)].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0);
}

function joinOr(values: string[]): string {
    return values.length <= 1
        ? values.join('')
        : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}
