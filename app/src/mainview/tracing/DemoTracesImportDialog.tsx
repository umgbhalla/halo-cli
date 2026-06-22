import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Ban,
  CheckCircle2,
  Clock3,
  Database,
  DownloadCloud,
  ExternalLink,
  Loader2,
  Play,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { Badge, Button, Dialog, cn, toast } from "~/lib/ui";
import { trpc } from "~/trpc";
import type { ImportJobProgress } from "./langfuse/ImportProgressStep";

type DialogStep = "source" | "download" | "import" | "done";

const DATASET_URL =
  "https://huggingface.co/datasets/inference-net/SearchAgentDemoTraces";

export function DemoTracesImportDialog({
  onImported,
  onOpenChange,
  open,
}: {
  onImported: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const utils = trpc.useUtils();
  const [step, setStep] = useState<DialogStep>("source");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const completedJobIdRef = useRef<string | null>(null);

  const activeJobQuery = trpc.fileImport.imports.get.useQuery(
    { jobId: activeJobId ?? "" },
    {
      enabled: open && Boolean(activeJobId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "running" ? 1_500 : false;
      },
    },
  );

  const markImported = useCallback(
    (jobId: string) => {
      if (completedJobIdRef.current === jobId) return;
      completedJobIdRef.current = jobId;
      onImported();
    },
    [onImported],
  );

  const loadDemo = trpc.fileImport.imports.loadDemo.useMutation({
    onError(error) {
      setErrorMessage(error.message);
      setStep("source");
      toast.error({
        title: "Could not load demo traces",
        description: error.message,
      });
    },
    async onSuccess(result) {
      setActiveJobId(result.job.id);
      utils.fileImport.imports.get.setData({ jobId: result.job.id }, result.job);
      setErrorMessage(null);
      setStep("import");
      await utils.fileImport.imports.list.invalidate();
      toast.info({
        title: result.cached ? "Demo traces cache found" : "Demo traces downloaded",
        description: "The sample trace import is now running locally.",
      });
    },
  });

  const cancelImport = trpc.fileImport.imports.cancel.useMutation({
    async onSuccess(job) {
      await utils.fileImport.imports.get.invalidate({ jobId: job.id });
      await utils.fileImport.imports.list.invalidate();
      toast.warning({
        title: "Import cancelled",
        description: "The demo trace import has been stopped.",
      });
    },
  });

  trpc.live.importJob.useSubscription(
    { jobId: activeJobId ?? "" },
    {
      enabled: open && Boolean(activeJobId),
      onData(eventEnvelope) {
        const event = eventEnvelope.data;
        if (event.payload.type !== "import.job.updated") return;
        const snapshot = event.payload.job;
        utils.fileImport.imports.get.setData(
          { jobId: snapshot.id },
          (current) =>
            current
              ? {
                  ...current,
                  ...snapshot,
                  status: snapshot.status as typeof current.status,
                }
              : current,
        );
        void utils.fileImport.imports.list.invalidate();
        if (snapshot.status === "completed") {
          setStep("done");
          markImported(snapshot.id);
        }
      },
    },
  );

  const latestJob = activeJobQuery.data;
  const activeStep = loadDemo.isPending ? "download" : step;
  const jobActive =
    latestJob?.status === "queued" ||
    latestJob?.status === "running" ||
    (activeStep === "import" && !latestJob);
  const jobFailed =
    latestJob?.status === "failed" ||
    latestJob?.status === "interrupted" ||
    latestJob?.status === "cancelled";

  useEffect(() => {
    if (!latestJob || !activeJobId) return;
    if (latestJob.status === "completed") {
      setStep("done");
      markImported(activeJobId);
    }
  }, [activeJobId, latestJob, markImported]);

  useEffect(() => {
    if (open || activeStep === "source" || activeStep === "download") return;
    if (jobActive) return;
    setActiveJobId(null);
    setErrorMessage(null);
    setStep("source");
    completedJobIdRef.current = null;
  }, [activeStep, jobActive, open]);

  const beginImport = () => {
    setErrorMessage(null);
    setStep("download");
    loadDemo.mutate();
  };

  return (
    <Dialog
      className="!w-[min(800px,92vw)] !max-w-[92vw] sm:!max-w-[800px] md:!w-[800px]"
      dialogDescription="Download public sample traces and import them into the local HALO timeline."
      dialogTitle="Load Demo Traces"
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-subtle px-6 py-4">
          <StepRail failed={jobFailed} step={activeStep} />
          <div className="flex items-center gap-2">
            {activeStep === "source" ? (
              <>
                <Button onClick={() => onOpenChange(false)} variant="ghost">
                  Close
                </Button>
                <Button disabled={loadDemo.isPending} onClick={beginImport}>
                  <Play className="mr-2 h-4 w-4" />
                  Load demo traces
                </Button>
              </>
            ) : null}
            {activeStep === "download" ? (
              <Button onClick={() => onOpenChange(false)} variant="ghost">
                Close
              </Button>
            ) : null}
            {activeStep === "import" || activeStep === "done" ? (
              jobActive ? (
                <Button
                  disabled={cancelImport.isPending || !latestJob}
                  onClick={() => {
                    if (latestJob) cancelImport.mutate({ jobId: latestJob.id });
                  }}
                  variant="secondary"
                >
                  <Ban className="mr-2 h-4 w-4" />
                  Cancel import
                </Button>
              ) : (
                <>
                  <Button onClick={() => onOpenChange(false)} variant="ghost">
                    Close
                  </Button>
                  <Button
                    disabled={loadDemo.isPending}
                    onClick={beginImport}
                    variant={jobFailed ? "default" : "secondary"}
                  >
                    {jobFailed ? (
                      <RotateCcw className="mr-2 h-4 w-4" />
                    ) : (
                      <Database className="mr-2 h-4 w-4" />
                    )}
                    {jobFailed ? "Retry demo import" : "Load again"}
                  </Button>
                </>
              )
            ) : null}
          </div>
        </div>
      }
      hideConfirmButton
      maxWidth={800}
      onConfirm={() => undefined}
      onOpenChange={onOpenChange}
      open={open}
    >
      <div className="space-y-5">
        <SourceStep
          activeStep={activeStep}
          errorMessage={errorMessage}
          job={latestJob}
        />
      </div>
    </Dialog>
  );
}

function SourceStep({
  activeStep,
  errorMessage,
  job,
}: {
  activeStep: DialogStep;
  errorMessage: string | null;
  job: ImportJobProgress | null | undefined;
}) {
  const showProgress = activeStep !== "source" || Boolean(job);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-subtle bg-background-muted p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Database className="h-4 w-4 text-detail-brand" />
          SearchAgentDemoTraces
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          HALO downloads an allowlisted JSONL export from Hugging Face, caches it
          beside your local app data, scans it, then queues the normal JSONL
          importer. No arbitrary remote URLs are accepted.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <InfoTile
          detail="Public Hugging Face dataset"
          icon={<DownloadCloud />}
          label="Source"
        />
        <InfoTile detail="Reused after first load" icon={<Database />} label="Cache" />
        <InfoTile detail="Local file import queue" icon={<CheckCircle2 />} label="Import" />
      </div>

      {showProgress ? <DemoImportStatusStrip job={job} step={activeStep} /> : null}

      <a
        className="flex items-center justify-between gap-3 rounded-lg border border-subtle bg-card px-4 py-3 text-sm transition hover:border-border hover:bg-card-hover/60"
        href={DATASET_URL}
        rel="noreferrer"
        target="_blank"
      >
        <span className="min-w-0">
          <span className="block font-medium">Dataset URL</span>
          <span className="block truncate text-muted-foreground">{DATASET_URL}</span>
        </span>
        <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
      </a>

      {errorMessage ? (
        <div className="rounded-md border border-detail-failure/30 bg-detail-failure/10 p-3">
          <p className="text-sm text-detail-failure">{errorMessage}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Local telemetry was not changed. Try again when the dataset is
            reachable, or use a JSONL file import.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function DemoImportStatusStrip({
  job,
  step,
}: {
  job: ImportJobProgress | null | undefined;
  step: DialogStep;
}) {
  const preparing = step === "download";
  const active =
    preparing || !job || job.status === "queued" || job.status === "running";
  const failed = job?.status === "failed" || job?.status === "interrupted";
  const cancelled = job?.status === "cancelled";
  const determinate = Boolean(job) && !preparing;

  return (
    <div className="rounded-xl border border-subtle bg-background-muted p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <DemoStatusIcon job={job} preparing={preparing} />
            <h3 className="text-base font-semibold">
              {statusTitle({ job, preparing })}
            </h3>
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {activityLine({ job, preparing })}
          </p>
        </div>
        <Badge
          variant={failed ? "status-failure" : active ? "status-running" : "outline"}
        >
          {preparing ? "preparing" : (job?.status ?? "starting")}
        </Badge>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
        {determinate ? (
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              failed
                ? "bg-detail-failure"
                : cancelled
                  ? "bg-muted-foreground"
                  : "bg-detail-brand",
            )}
            style={{ width: `${Math.max(2, job?.progress ?? 0)}%` }}
          />
        ) : (
          <div className="h-full w-2/3 animate-pulse rounded-full bg-detail-brand" />
        )}
      </div>

      {job ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {job.totalTraces > 0
            ? `${job.importedTraces.toLocaleString()} / ${job.totalTraces.toLocaleString()} traces imported`
            : `${job.importedTraces.toLocaleString()} traces imported`}
          {job.importedObservations > 0
            ? ` - ${job.importedObservations.toLocaleString()} observations`
            : ""}
        </p>
      ) : null}

      {job?.errorMessage && !active ? (
        <div className="mt-4 rounded-md border border-detail-failure/30 bg-detail-failure/10 p-3">
          <p className="text-sm text-detail-failure">{job.errorMessage}</p>
          {failed ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Imports resume where they left off - already-imported traces are kept.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DemoStatusIcon({
  job,
  preparing,
}: {
  job: ImportJobProgress | null | undefined;
  preparing: boolean;
}) {
  if (preparing || !job || job.status === "running") {
    return <Loader2 className="h-5 w-5 animate-spin text-detail-brand" />;
  }
  if (job.status === "completed") {
    return <CheckCircle2 className="h-5 w-5 text-detail-success" />;
  }
  if (job.status === "failed" || job.status === "interrupted") {
    return <XCircle className="h-5 w-5 text-detail-failure" />;
  }
  if (job.status === "cancelled") {
    return <Ban className="h-5 w-5 text-muted-foreground" />;
  }
  return <Clock3 className="h-5 w-5 text-detail-brand" />;
}

function statusTitle({
  job,
  preparing,
}: {
  job: ImportJobProgress | null | undefined;
  preparing: boolean;
}) {
  if (preparing) return "Preparing demo traces";
  if (!job) return "Starting import";
  if (job.status === "completed") return "Import complete";
  if (job.status === "failed") return "Import failed";
  if (job.status === "cancelled") return "Import cancelled";
  if (job.status === "interrupted") return "Import interrupted";
  if (job.status === "queued") return "Import queued";
  return "Importing traces";
}

function activityLine({
  job,
  preparing,
}: {
  job: ImportJobProgress | null | undefined;
  preparing: boolean;
}) {
  if (preparing) {
    return "Checking the cache and downloading from Hugging Face if needed...";
  }
  if (!job) return "Starting the local file import job...";
  if (job.status === "queued") return "Waiting in the import queue...";
  if (job.status === "running") {
    if (job.currentTraceId && job.currentTraceName) {
      return `Importing "${job.currentTraceName}"`;
    }
    if (job.currentTraceName) return job.currentTraceName;
    return "Importing the demo dataset...";
  }
  if (job.status === "completed") {
    return "Demo traces are now available in the local HALO timeline.";
  }
  if (job.status === "cancelled") return "The demo import was stopped.";
  return "The demo import did not finish.";
}

function InfoTile({
  detail,
  icon,
  label,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <div className="rounded-xl border border-subtle bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <span className="text-detail-brand [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        {label}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function StepRail({ failed, step }: { failed?: boolean; step: DialogStep }) {
  const steps: DialogStep[] = ["source", "download", "import", "done"];
  const activeIndex = steps.indexOf(step);
  return (
    <div className="hidden items-center gap-2 md:flex">
      {steps.map((item, index) => {
        const failedStep = failed && item === "import" && index <= activeIndex;
        return (
          <div className="flex items-center gap-2" key={item}>
            <span
              className={cn(
                "grid h-6 min-w-6 place-items-center rounded-full border text-[11px]",
                failedStep
                  ? "border-detail-failure bg-detail-failure/15 text-detail-failure"
                  : index <= activeIndex
                    ? "border-detail-brand bg-detail-brand/15 text-detail-brand"
                    : "border-subtle text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span className="text-xs capitalize text-muted-foreground">{item}</span>
            {index < steps.length - 1 ? (
              <span className="h-px w-5 bg-border/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
