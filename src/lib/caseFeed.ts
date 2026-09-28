import { byMostRecent, type SlashingCase } from '@shared/protocol/index.ts';

export interface CasePayloadGroup {
    id: string;
    payloadAddress: string | null;
    round: string | null;
    cases: SlashingCase[];
}

export function groupCasesByPayload(
    cases: readonly SlashingCase[],
): CasePayloadGroup[] {
    const groups = new Map<string, CasePayloadGroup>();
    for (const item of cases) {
        const payloadAddress = payloadForCase(item);
        const id = payloadAddress
            ? `payload:${payloadAddress}`
            : `case:${item.id}`;
        const existing = groups.get(id);
        if (existing) {
            existing.cases.push(item);
            if (!existing.round) existing.round = roundForCase(item);
            continue;
        }
        groups.set(id, {
            id,
            payloadAddress,
            round: roundForCase(item),
            cases: [item],
        });
    }
    return [...groups.values()].sort(comparePayloadGroups);
}

function payloadForCase(item: SlashingCase): string | null {
    if (isAddress(item.state.payloadAddress)) {
        return item.state.payloadAddress.toLowerCase();
    }
    const round = [...item.observations].reverse().find((observation) =>
        observation.provenance.canonical &&
        observation.kind === 'l1_round' &&
        isAddress(observation.data.payloadAddress));
    return isAddress(round?.data.payloadAddress)
        ? round.data.payloadAddress.toLowerCase()
        : null;
}

function roundForCase(item: SlashingCase): string | null {
    if (item.state.round) return item.state.round;
    const observation = [...item.observations].reverse().find((candidate) =>
        candidate.provenance.canonical &&
        candidate.kind === 'l1_round');
    if (observation?.round) return observation.round;
    return typeof observation?.data.round === 'string'
        ? observation.data.round
        : null;
}

function isAddress(value: unknown): value is string {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function comparePayloadGroups(
    left: CasePayloadGroup,
    right: CasePayloadGroup,
): number {
    if (left.payloadAddress && !right.payloadAddress) return -1;
    if (!left.payloadAddress && right.payloadAddress) return 1;
    if (left.payloadAddress && right.payloadAddress) {
        const leftRound = unsignedInteger(left.round);
        const rightRound = unsignedInteger(right.round);
        if (leftRound !== null && rightRound !== null && leftRound !== rightRound) {
            return leftRound > rightRound ? -1 : 1;
        }
        if (leftRound !== null && rightRound === null) return -1;
        if (leftRound === null && rightRound !== null) return 1;
        return left.payloadAddress.localeCompare(right.payloadAddress);
    }
    return byMostRecent(left.cases[0], right.cases[0]);
}

function unsignedInteger(value: string | null): bigint | null {
    return value !== null && /^\d+$/.test(value)
        ? BigInt(value)
        : null;
}
