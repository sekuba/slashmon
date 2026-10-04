import { formatAztec } from '@shared/protocol/index.ts';
import { PROTOCOL_TONES } from '@/lib/protocolTones';
import type { NetworkSummary, ProtocolSnapshot } from '@/types/backendApi';

export function NetworkHealth({
    summary,
    protocol,
}: {
    summary: NetworkSummary;
    protocol: ProtocolSnapshot | null;
}) {
    const stats = [
        ['Duty misses', summary.precursors, PROTOCOL_TONES.node.surface],
        ['Node offenses', summary.nodeOffenses, PROTOCOL_TONES.node.surface],
        ['L1 votes', summary.l1Supported, PROTOCOL_TONES.voting.surface],
        ['Candidates', summary.candidates, PROTOCOL_TONES.voting.surface],
        ['Executable', summary.executable, PROTOCOL_TONES.execution.surface],
        ['Stake removed', summary.actualSlashes, PROTOCOL_TONES.outcome.surface],
        ['Ejections', summary.ejections, PROTOCOL_TONES.outcome.surface],
    ];
    return (
        <section className="mb-8 border-6 border-aqua bg-lapis p-5 shadow-brutal-aqua sm:p-7">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-aqua">
                        Current network health
                    </p>
                    <h2 className="mt-1 text-3xl font-black text-whisper-white">
                        Cases indexed
                    </h2>
                </div>
                <span className="border-3 border-brand-black bg-aqua px-3 py-2 text-xs font-black uppercase text-brand-black">
                    L1 block {protocol?.blockNumber ?? '—'}
                </span>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
                {stats.map(([label, value, tone]) => (
                    <div key={String(label)} className={`border-3 p-3 ${tone}`}>
                        <strong className="inline-block min-w-10 text-center text-2xl font-black text-whisper-white">
                            {String(value)}
                        </strong>
                        <p className="mt-2 text-xs font-black uppercase">
                            {label}
                        </p>
                    </div>
                ))}
            </div>
            <p className="mt-4 text-sm font-bold text-whisper-white/75">
                Requested stake currently at risk: <strong className="text-vermillion">
                    {formatAztec(summary.stakeAtRisk)} AZTEC
                </strong>. Requested penalties and actual deductions are kept separate.
            </p>
        </section>
    );
}
