export type RoundStatus =
    | 'executed'
    | 'expired'
    | 'below-quorum'
    | 'quorum-reached'
    | 'newly-executable'
    | 'executable';

export interface RoundTiming {
    roundSizeSlots: number | bigint;
    executionDelayRounds: number | bigint;
    lifetimeRounds: number | bigint;
}

export interface RoundTargeting {
    slashOffsetRounds: number | bigint;
    roundSizeEpochs: number | bigint;
}

export function executableSlot(round: bigint, timing: RoundTiming): bigint {
    return (round + 1n + BigInt(timing.executionDelayRounds)) * BigInt(timing.roundSizeSlots);
}

export function expirySlot(round: bigint, timing: RoundTiming): bigint {
    return (round + 1n + BigInt(timing.lifetimeRounds)) * BigInt(timing.roundSizeSlots);
}

export function roundStatus(
    input: {
        round: bigint;
        currentRound: bigint;
        currentSlot: bigint;
        isExecuted: boolean;
        hasActions: boolean;
    },
    timing: RoundTiming,
): RoundStatus {
    if (input.isExecuted) return 'executed';
    if (input.currentRound > input.round + BigInt(timing.lifetimeRounds)) return 'expired';
    if (!input.hasActions) return 'below-quorum';
    const delay = BigInt(timing.executionDelayRounds);
    const isPastDelay = input.currentRound > input.round + delay;
    if (isPastDelay && input.currentSlot >= executableSlot(input.round, timing)) {
        return input.currentRound === input.round + delay + 1n
            ? 'newly-executable'
            : 'executable';
    }
    return 'quorum-reached';
}

// A pause protects a candidate only when it covers the complete remaining
// execution window: the candidate must expire after the pause started and no
// later than the pause ends.
export function isRoundProtectedByPause(
    input: {
        round: bigint;
        isSlashingEnabled: boolean;
        pauseStartedAtSlot: bigint | null;
        pauseEndsAtSlot: bigint | null;
        slashOffsetRounds: number | bigint;
    },
    timing: RoundTiming,
): boolean {
    if (
        input.isSlashingEnabled ||
        input.pauseStartedAtSlot === null ||
        input.pauseEndsAtSlot === null ||
        input.round < BigInt(input.slashOffsetRounds)
    ) {
        return false;
    }
    const roundExpiresAtSlot = expirySlot(input.round, timing);
    return roundExpiresAtSlot > input.pauseStartedAtSlot &&
        roundExpiresAtSlot <= input.pauseEndsAtSlot;
}

// The one voting round whose ballots can target an epoch: the inverse of
// targetEpochs.
export function votingRoundForEpoch(epoch: bigint, targeting: RoundTargeting): bigint {
    return epoch / BigInt(targeting.roundSizeEpochs) + BigInt(targeting.slashOffsetRounds);
}

export function targetEpochs(votingRound: bigint, targeting: RoundTargeting): bigint[] {
    const slashOffset = BigInt(targeting.slashOffsetRounds);
    if (votingRound < slashOffset) return [];
    const roundSizeEpochs = BigInt(targeting.roundSizeEpochs);
    const startEpoch = (votingRound - slashOffset) * roundSizeEpochs;
    return Array.from(
        { length: Number(roundSizeEpochs) },
        (_, offset) => startEpoch + BigInt(offset),
    );
}
