import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { Button, cn } from "~/lib/ui";
import { trpc } from "~/trpc";
import { ImportDataScreen, LocalAgentSetupDialog } from "~/tracing/ImportDataScreen";
import { FileImportDialog } from "~/tracing/fileimport/FileImportDialog";
import { LangfuseImportDialog } from "~/tracing/langfuse/LangfuseImportDialog";
import { PhoenixImportDialog } from "~/tracing/phoenix/PhoenixImportDialog";

type OnboardingStep = "welcome" | "video" | "import";

const DEFAULT_INGEST_URL = "http://127.0.0.1:8799/v1/traces";

const STEPS: Array<{ id: OnboardingStep; label: string }> = [
  { id: "welcome", label: "Welcome" },
  { id: "video", label: "Video" },
  { id: "import", label: "Import" },
];

export function OnboardingPage() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<OnboardingStep>("welcome");

  const completeMutation = trpc.onboarding.complete.useMutation({
    async onSuccess() {
      await utils.onboarding.get.invalidate();
    },
  });

  const finish = async () => {
    await completeMutation.mutateAsync();
    void navigate({
      search: {
        followLatest: undefined,
        sessionId: undefined,
        traceId: undefined,
        view: undefined,
      },
      to: "/",
    });
  };

  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const goNext = () => {
    const next = STEPS[stepIndex + 1]?.id;
    if (next) setStep(next);
  };

  return (
    <main className="min-h-screen overflow-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-8 py-10">
        <header className="flex items-center justify-between">
          <StepRail onStepChange={setStep} step={step} />
          <Button
            onClick={() => void finish()}
            size="sm"
            variant="secondary"
          >
            Skip Onboarding
          </Button>
        </header>

        <div className="flex flex-1 flex-col pt-20 pb-10">
          {step === "welcome" ? <WelcomeStep onContinue={goNext} /> : null}
          {step === "video" ? (
            <VideoStep onBack={() => setStep("welcome")} onContinue={goNext} />
          ) : null}
          {step === "import" ? (
            <ImportStep onBack={() => setStep("video")} onFinish={() => void finish()} />
          ) : null}
        </div>
      </div>
    </main>
  );
}

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <OnboardingStepLayout
      description="HALO helps you understand what your AI agents are doing by collecting traces, sessions, and telemetry in one local workspace."
      primaryAction={
        <Button onClick={onContinue} size="sm" variant="secondary">
          Next
          <ArrowRight className="ml-2 h-3.5 w-3.5" />
        </Button>
      }
      title="Welcome to HALO"
    >
      <div className="max-w-2xl space-y-4 text-base leading-7 text-muted-foreground">
        <p>
          Watch the short walkthrough, then bring in your first traces when you
          are ready.
        </p>
      </div>
    </OnboardingStepLayout>
  );
}

function VideoStep({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <OnboardingStepLayout
      description="Learn how to inspect agent traces, follow sessions, and bring data into HALO."
      onBack={onBack}
      primaryAction={
        <Button onClick={onContinue} size="sm" variant="secondary">
          Next
          <ArrowRight className="ml-2 h-3.5 w-3.5" />
        </Button>
      }
      title="Watch the HALO walkthrough"
    >
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="relative aspect-video w-full">
          <iframe
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 h-full w-full"
            src="https://www.youtube.com/embed/SGKrnYSttBI"
            title="How to use HALO"
          />
        </div>
      </div>
    </OnboardingStepLayout>
  );
}

function ImportStep({
  onBack,
  onFinish,
}: {
  onBack: () => void;
  onFinish: () => void;
}) {
  const [langfuseDialogOpen, setLangfuseDialogOpen] = useState(false);
  const [phoenixDialogOpen, setPhoenixDialogOpen] = useState(false);
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [localAgentSetupOpen, setLocalAgentSetupOpen] = useState(false);
  const utils = trpc.useUtils();
  const infoQuery = trpc.telemetry.info.useQuery();

  const ingestUrl = infoQuery.data?.ingestUrl ?? DEFAULT_INGEST_URL;
  const catalystEnvLine = `CATALYST_OTLP_ENDPOINT=${ingestUrl}`;

  const refreshTelemetry = useCallback(() => {
    void infoQuery.refetch();
    void utils.traces.facets.invalidate();
    void utils.traces.list.invalidate();
    void utils.traces.search.invalidate();
    void utils.sessions.facets.invalidate();
    void utils.sessions.list.invalidate();
    void utils.sessions.search.invalidate();
  }, [infoQuery, utils]);

  trpc.live.workspace.useSubscription(undefined, {
    onData() {
      void utils.telemetry.info.invalidate();
    },
  });

  return (
    <OnboardingStepLayout
      description="Import existing data from a provider, upload a file, or connect a live agent."
      onBack={onBack}
      primaryAction={
        <Button onClick={onFinish} size="sm" variant="secondary">
          Dashboard
          <ArrowRight className="ml-2 h-3.5 w-3.5" />
        </Button>
      }
      title="Import Agent Traces"
    >
      <ImportDataScreen
        compact
        hideHeader
        onConnectLocalAgent={() => setLocalAgentSetupOpen(true)}
        onImportJsonl={() => setFileDialogOpen(true)}
        onImportLangfuse={() => setLangfuseDialogOpen(true)}
        onImportPhoenix={() => setPhoenixDialogOpen(true)}
      />

      <LangfuseImportDialog
        onImported={refreshTelemetry}
        onOpenChange={setLangfuseDialogOpen}
        open={langfuseDialogOpen}
      />
      <PhoenixImportDialog
        onImported={refreshTelemetry}
        onOpenChange={setPhoenixDialogOpen}
        open={phoenixDialogOpen}
      />
      <FileImportDialog
        onImported={refreshTelemetry}
        onOpenChange={setFileDialogOpen}
        open={fileDialogOpen}
      />
      <LocalAgentSetupDialog
        envLine={catalystEnvLine}
        ingestUrl={ingestUrl}
        onOpenChange={setLocalAgentSetupOpen}
        open={localAgentSetupOpen}
      />
    </OnboardingStepLayout>
  );
}

function OnboardingStepLayout({
  children,
  description,
  onBack,
  primaryAction,
  title,
}: {
  children: ReactNode;
  description: string;
  onBack?: () => void;
  primaryAction: ReactNode;
  title: string;
}) {
  return (
    <section className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-8">
        <h1 className="text-3xl font-medium tracking-normal">{title}</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">
          {description}
        </p>
      </div>

      <div>{children}</div>

      <footer className="mt-8 flex items-center justify-between">
        {onBack ? (
          <Button onClick={onBack} size="sm" variant="secondary">
            <ArrowLeft className="mr-2 h-3.5 w-3.5" />
            Back
          </Button>
        ) : (
          <div aria-hidden="true" />
        )}
        {primaryAction}
      </footer>
    </section>
  );
}

function StepRail({
  onStepChange,
  step,
}: {
  onStepChange: (step: OnboardingStep) => void;
  step: OnboardingStep;
}) {
  const activeIndex = STEPS.findIndex((item) => item.id === step);
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((item, index) => {
        const reachable = index <= activeIndex;
        return (
        <div className="flex items-center gap-2" key={item.id}>
          <button
            className={cn(
              "flex items-center gap-2 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              reachable
                ? "cursor-pointer text-muted-foreground hover:text-foreground"
                : "cursor-default text-muted-foreground/50",
            )}
            disabled={!reachable}
            onClick={() => onStepChange(item.id)}
            type="button"
          >
            <span
              className={cn(
                "grid h-6 min-w-6 place-items-center rounded-full border text-[11px]",
                index <= activeIndex
                  ? "border-detail-brand bg-detail-brand/15 text-detail-brand"
                  : "border-subtle text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span className="hidden text-xs sm:inline">{item.label}</span>
          </button>
          {index < STEPS.length - 1 ? (
            <span className="h-px w-5 bg-border/50" />
          ) : null}
        </div>
        );
      })}
    </div>
  );
}
