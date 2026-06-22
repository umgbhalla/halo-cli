import type { ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";

import { cn } from "~/lib/ui";
import type { HaloRunView } from "./runShared";

type PhaseState = "active" | "done" | "failed" | "pending";

type Phase = {
  detail?: string;
  label: string;
  state: PhaseState;
};

/**
 * Compact stepper derived from the run status. Cancelled/interrupted/failed
 * runs mark the phase they died in.
 */
export function RunPhaseTimeline({ run }: { run: HaloRunView }) {
  const phases = derivePhases(run);
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {phases.map((phase, index) => (
        <div className="flex items-center gap-1" key={phase.label}>
          <PhaseChip phase={phase} />
          {index < phases.length - 1 ? (
            <span
              className={cn(
                "h-px w-3",
                phase.state === "done" ? "bg-detail-brand/50" : "bg-border",
              )}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PhaseChip({ phase }: { phase: Phase }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        phase.state === "done" &&
          "border-detail-success/30 bg-detail-success/10 text-detail-success",
        phase.state === "active" &&
          "border-detail-brand/30 bg-detail-brand/10 text-detail-brand",
        phase.state === "failed" &&
          "border-detail-failure/30 bg-detail-failure/10 text-detail-failure",
        phase.state === "pending" && "border-subtle text-muted-foreground",
      )}
      title={phase.detail}
    >
      <PhaseIcon state={phase.state} />
      {phase.label}
      {phase.detail ? (
        <span className="hidden text-[10px] opacity-75 sm:inline">
          {phase.detail}
        </span>
      ) : null}
    </span>
  );
}

function PhaseIcon({ state }: { state: PhaseState }): ReactNode {
  if (state === "done") return <Check className="h-2.5 w-2.5" />;
  if (state === "active") return <Loader2 className="h-2.5 w-2.5 animate-spin" />;
  if (state === "failed") return <X className="h-2.5 w-2.5" />;
  return <span className="h-1 w-1 rounded-full bg-current opacity-40" />;
}

function derivePhases(run: HaloRunView): Phase[] {
  // Phase index the run is currently in (or died in).
  const activeIndex =
    run.status === "queued"
      ? 0
      : run.status === "exporting"
        ? 1
        : run.status === "running"
          ? 2
          : 3;
  const terminalOk = run.status === "completed" || run.status === "incomplete";
  const terminalBad = ["failed", "cancelled", "interrupted"].includes(run.status);

  const doneLabel = terminalBad
    ? run.status === "cancelled"
      ? "Cancelled"
      : run.status === "interrupted"
        ? "Interrupted"
        : "Failed"
    : run.status === "incomplete"
      ? "Done (partial)"
      : "Done";

  // For dead runs, progress hints at the phase that was active when it died:
  // queued sits at 0, export runs 5-18, analysis 25-92.
  const diedIndex = run.progress <= 5 ? 0 : run.progress <= 24 ? 1 : 2;

  const stateFor = (index: number): PhaseState => {
    if (terminalOk) return "done";
    if (terminalBad) {
      if (index === 3) return "failed";
      if (index < diedIndex) return "done";
      if (index === diedIndex) return "failed";
      return "pending";
    }
    if (index < activeIndex) return "done";
    if (index === activeIndex) return "active";
    return "pending";
  };

  return [
    { label: "Queued", state: stateFor(0) },
    { label: "Export", state: stateFor(1) },
    { label: "Analysis", state: stateFor(2) },
    { label: doneLabel, state: stateFor(3) },
  ];
}
