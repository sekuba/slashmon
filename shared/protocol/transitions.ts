import { stageLabel } from './cases.ts';
import { formatAztec, shortAddress } from './format.ts';
import type {
    CaseStage,
    CaseState,
    CaseTransition,
    SlashingCase,
    TransitionSeverity,
} from './types.ts';

const OFFENSE_STAGES = new Set<CaseStage>(['node_offense', 'awaiting_round']);

// Renders the notification for a case-state change. This wording is the
// single source for Telegram and Web Push copy. `observedAt` defaults to the
// case's latest evidence; a change caused by protocol time alone passes the
// time it was observed.
export function transitionFor(
    previous: SlashingCase | null,
    current: SlashingCase,
    observedAt = current.lastObservedAt,
): CaseTransition | null {
    // The l1_support headline embeds the live ballot count, so the generic
    // headline comparison below would notify on every additional ballot.
    // Alert on the first vote and quorum, not intermediate counts.
    if (
        previous?.state.stage === 'l1_support' &&
        current.state.stage === 'l1_support'
    ) {
        return null;
    }
    // The voting round opening for a recorded offense is not a new offense.
    if (
        previous &&
        OFFENSE_STAGES.has(previous.state.stage) &&
        OFFENSE_STAGES.has(current.state.stage) &&
        previous.state.requestedAmount === current.state.requestedAmount &&
        previous.state.reason.label === current.state.reason.label
    ) {
        return null;
    }
    // A case closed without a slash does not alert again for another closing
    // reason, and duty evidence that closes without ever reaching L1 closes
    // silently: its own alert already went out, and nothing is left to do.
    if (
        current.state.stage === 'resolved' &&
        (
            previous?.state.stage === 'resolved' ||
            (
                (previous === null || previous.state.stage === 'precursor') &&
                !current.observations.some((item) =>
                    item.source === 'ethereum_l1' && item.provenance.canonical)
            )
        )
    ) {
        return null;
    }
    if (
        previous &&
        previous.state.stage === current.state.stage &&
        previous.state.headline === current.state.headline &&
        previous.state.requestedAmount === current.state.requestedAmount &&
        previous.state.actualAmount === current.state.actualAmount &&
        previous.state.payloadAddress === current.state.payloadAddress
    ) {
        return null;
    }

    const from = previous?.state.stage ?? null;
    return {
        id: [
            'transition',
            current.id,
            from ?? 'new',
            current.state.stage,
            observedAt,
        ].join(':'),
        caseId: current.id,
        sequencer: current.sequencer,
        fromStage: from,
        toStage: current.state.stage,
        severity: transitionSeverity(current.state),
        title: `${shortAddress(current.sequencer)} · ${stageLabel(current.state.stage)}`,
        body: transitionBody(previous, current, observedAt),
        observedAt,
    };
}

function transitionBody(
    previous: SlashingCase | null,
    item: SlashingCase,
    observedAt: string,
): string {
    const lines = [
        `Event: ${transitionEventLabel(previous, item)}`,
        `Epoch: ${item.targetEpoch}`,
    ];
    const slot = transitionSlot(item);
    if (slot) lines.push(`Slot: ${slot}`);
    const round = transitionRound(item);
    if (round) lines.push(`Round: ${round}`);
    lines.push(`Time: ${formatTime(observedAt)}`);
    lines.push(item.state.reason.provenance === 'node_evidence'
        ? `Reason: ${item.state.reason.label} (node evidence)`
        : 'Reason: Not encoded on L1');
    if (item.state.nextTransition) {
        let next = `Next: ${item.state.nextTransition.label}`;
        if (item.state.nextTransition.at) {
            next += ` at ${formatTime(item.state.nextTransition.at)}`;
        }
        if (item.state.nextTransition.slot) {
            next += `${item.state.nextTransition.at ? ' ·' : ' at'} ` +
                `slot ${item.state.nextTransition.slot}`;
        }
        lines.push(next);
    }
    return lines.join('\n');
}

function transitionEventLabel(
    previous: SlashingCase | null,
    item: SlashingCase,
): string {
    const requested = tokenAmount(item.state.requestedAmount);
    const actual = tokenAmount(item.state.actualAmount);
    switch (item.state.stage) {
        case 'precursor':
            return item.state.headline === 'Missed duty observed'
                ? 'Duty missed'
                : item.state.headline;
        case 'node_offense':
        case 'awaiting_round':
            return 'Offense recorded by this node';
        case 'l1_support':
            return previous && [
                'candidate',
                'delayed',
                'executable',
                'vetoed',
            ].includes(previous.state.stage)
                ? 'Slash support fell below quorum'
                : 'First L1 slash vote recorded';
        case 'candidate':
            return requested
                ? `Quorum reached for a ${requested} slash`
                : 'Slash quorum reached';
        case 'delayed':
            return requested
                ? `Voting closed for a ${requested} slash`
                : 'Voting closed for the slash candidate';
        case 'executable':
            return requested
                ? `${requested} slash became executable`
                : 'Slash became executable';
        case 'vetoed':
            return 'Slash candidate vetoed';
        case 'expired':
            return 'Slash candidate expired';
        case 'executed':
            return requested
                ? `Slash round executed for a ${requested} action`
                : 'Slash round executed';
        case 'stake_removed':
            return actual ? `${actual} slashed` : 'Stake slashed';
        case 'ejected':
            return actual
                ? `Sequencer ejected after a ${actual} slash`
                : 'Sequencer ejected';
        case 'resolved':
            return item.state.headline;
        case 'reorged':
            return 'L1 evidence removed';
    }
}

function tokenAmount(value: string | null): string | null {
    return value ? `${formatAztec(value)} AZTEC` : null;
}

function transitionSlot(item: SlashingCase): string | null {
    const observation = [...item.observations].reverse().find((candidate) =>
        candidate.provenance.canonical &&
        candidate.slot &&
        (candidate.provenance.invalidatedAt ?? candidate.provenance.observedAt) ===
            item.lastObservedAt);
    return observation?.slot ?? null;
}

function transitionRound(item: SlashingCase): string | null {
    if (item.state.round) return item.state.round;
    return [...item.observations].reverse().find((candidate) =>
        candidate.provenance.canonical && candidate.round)?.round ?? null;
}

function formatTime(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, ' UTC');
}

function transitionSeverity(stateValue: CaseState): TransitionSeverity {
    if (stateValue.urgency === 'critical') return 'critical';
    if (stateValue.urgency === 'warning') return 'warning';
    return 'info';
}
