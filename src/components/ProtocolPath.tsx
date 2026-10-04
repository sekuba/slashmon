import type { CSSProperties } from 'react';
import type { CaseStage, SlashingCase } from '@shared/protocol/index.ts';
import { PROTOCOL_TONES } from '@/lib/protocolTones';

export const PROTOCOL_PATH: ReadonlyArray<{
    stage: CaseStage;
    label: string;
    activeTone: string;
    reachedTone: string;
    pulseColor: string;
}> = [
    {
        stage: 'precursor',
        label: 'Duty miss',
        activeTone: PROTOCOL_TONES.node.active,
        reachedTone: PROTOCOL_TONES.node.surface,
        pulseColor: PROTOCOL_TONES.node.pulseColor,
    },
    {
        stage: 'node_offense',
        label: 'Node offense',
        activeTone: PROTOCOL_TONES.node.active,
        reachedTone: PROTOCOL_TONES.node.surface,
        pulseColor: PROTOCOL_TONES.node.pulseColor,
    },
    {
        stage: 'l1_support',
        label: 'L1 votes',
        activeTone: PROTOCOL_TONES.voting.active,
        reachedTone: PROTOCOL_TONES.voting.surface,
        pulseColor: PROTOCOL_TONES.voting.pulseColor,
    },
    {
        stage: 'candidate',
        label: 'Candidate',
        activeTone: PROTOCOL_TONES.voting.active,
        reachedTone: PROTOCOL_TONES.voting.surface,
        pulseColor: PROTOCOL_TONES.voting.pulseColor,
    },
    {
        stage: 'delayed',
        label: 'Delay',
        activeTone: PROTOCOL_TONES.execution.active,
        reachedTone: PROTOCOL_TONES.execution.surface,
        pulseColor: PROTOCOL_TONES.execution.pulseColor,
    },
    {
        stage: 'executable',
        label: 'Executable',
        activeTone: PROTOCOL_TONES.execution.active,
        reachedTone: PROTOCOL_TONES.execution.surface,
        pulseColor: PROTOCOL_TONES.execution.pulseColor,
    },
    {
        stage: 'executed',
        label: 'Executed',
        activeTone: PROTOCOL_TONES.execution.active,
        reachedTone: PROTOCOL_TONES.execution.surface,
        pulseColor: PROTOCOL_TONES.execution.pulseColor,
    },
    {
        stage: 'stake_removed',
        label: 'Stake removed',
        activeTone: PROTOCOL_TONES.outcome.active,
        reachedTone: PROTOCOL_TONES.outcome.surface,
        pulseColor: PROTOCOL_TONES.outcome.pulseColor,
    },
    {
        stage: 'ejected',
        label: 'Ejection',
        activeTone: PROTOCOL_TONES.outcome.active,
        reachedTone: PROTOCOL_TONES.outcome.surface,
        pulseColor: PROTOCOL_TONES.outcome.pulseColor,
    },
];

const CURRENT_STEP: Partial<Record<CaseStage, number>> = {
    precursor: 0,
    node_offense: 1,
    awaiting_round: 1,
    l1_support: 2,
    candidate: 3,
    delayed: 4,
    vetoed: 4,
    executable: 5,
    executed: 6,
    stake_removed: 7,
    ejected: 8,
};

export function ProtocolPath({
    item,
    onOpenGuide,
}: {
    item: SlashingCase;
    onOpenGuide: () => void;
}) {
    const current = CURRENT_STEP[item.state.stage] ?? null;
    const reached = reachedStages(item);

    return (
        <div className="mt-6">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                <p className="text-xs font-black uppercase tracking-[0.14em] text-whisper-white/55">
                    Slashing timeline
                </p>
                <button
                    type="button"
                    onClick={onOpenGuide}
                    className="min-h-11 px-1 text-xs font-black uppercase text-aqua underline decoration-2 underline-offset-4 hover:text-chartreuse"
                >
                    Explain timeline →
                </button>
            </div>
            <ol className="grid gap-2 md:grid-cols-9" aria-label="Slashing timeline">
                {PROTOCOL_PATH.map((step, index) => {
                    const active = index === current;
                    const complete = !active && reached.has(step.stage);
                    return (
                        <li
                            key={step.stage}
                            className={`min-w-0 border-3 p-2 text-xs font-black uppercase ${
                                active
                                    ? step.activeTone
                                    : complete
                                        ? step.reachedTone
                                        : 'border-whisper-white/30 text-whisper-white/45'
                            } ${active && item.state.active ? 'brutal-border-pulse' : ''}`}
                            style={active && item.state.active
                                ? { '--pulse-color': step.pulseColor } as CSSProperties
                                : undefined}
                            aria-current={active ? 'step' : undefined}
                        >
                            <span className="mr-1">{complete ? '✓' : index + 1}</span>
                            {step.label}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function reachedStages(item: SlashingCase): Set<CaseStage> {
    const reached = new Set<CaseStage>();
    const canonical = item.observations.filter((observation) =>
        observation.provenance.canonical);
    if (canonical.some((observation) =>
        observation.kind === 'duty_miss' || observation.kind === 'inactivity_epoch')) {
        reached.add('precursor');
    }
    if (canonical.some((observation) => observation.kind === 'node_offense')) {
        reached.add('node_offense');
    }
    const round = [...canonical].reverse().find(
        (observation) => observation.kind === 'l1_round',
    );
    if (round) {
        reached.add('l1_support');
        if (round.data.amount) reached.add('candidate');
        if (round.data.amount && round.data.stable) reached.add('delayed');
        if (['newly-executable', 'executable', 'executed'].includes(
            String(round.data.status ?? ''),
        )) {
            reached.add('executable');
        }
        if (round.data.isExecuted || round.data.status === 'executed') {
            reached.add('executed');
        }
    }
    if (canonical.some((observation) => observation.kind === 'l1_slash')) {
        reached.add('stake_removed');
    }
    if (canonical.some((observation) =>
        observation.kind === 'stake_status' && observation.data.ejected)) {
        reached.add('ejected');
    }
    return reached;
}
