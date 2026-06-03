import { useCallback, useState } from "react";
import { Trash2 } from "lucide-react";

import { Dialog, toast } from "~/lib/ui";
import { trpc } from "~/trpc";
import { WorkspaceNav } from "~/workspace/WorkspaceNav";
import { ImportDataScreen, LocalAgentSetupDialog } from "./ImportDataScreen";
import { LangfuseImportDialog } from "./LangfuseImportDialog";
import { TraceTitleBar, type LiveStatus } from "./TraceTitleBar";

const DEFAULT_INGEST_URL = "http://127.0.0.1:8799/v1/traces";

export function ImportDataRoutePage() {
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [localAgentSetupOpen, setLocalAgentSetupOpen] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const utils = trpc.useUtils();
  const infoQuery = trpc.telemetry.info.useQuery();

  const ingestUrl = infoQuery.data?.ingestUrl ?? DEFAULT_INGEST_URL;
  const catalystEnvLine = `CATALYST_OTLP_ENDPOINT=${ingestUrl}`;
  const isRefreshing = infoQuery.isFetching;

  const refreshTelemetry = useCallback(() => {
    void infoQuery.refetch();
    void utils.traces.facets.invalidate();
    void utils.traces.list.invalidate();
    void utils.traces.search.invalidate();
    void utils.sessions.facets.invalidate();
    void utils.sessions.list.invalidate();
    void utils.sessions.search.invalidate();
  }, [infoQuery, utils]);

  const clearDataMutation = trpc.telemetry.clearData.useMutation({
    onError(error) {
      toast.error({
        title: "Could not clear telemetry data",
        description: error.message,
      });
    },
    async onSuccess(result) {
      setClearDialogOpen(false);
      await Promise.all([
        utils.telemetry.info.invalidate(),
        utils.traces.facets.invalidate(),
        utils.traces.list.invalidate(),
        utils.traces.search.invalidate(),
        utils.traces.get.invalidate(),
        utils.traces.getSpans.invalidate(),
        utils.spans.list.invalidate(),
        utils.spans.facets.invalidate(),
        utils.sessions.facets.invalidate(),
        utils.sessions.list.invalidate(),
        utils.sessions.search.invalidate(),
        utils.sessions.get.invalidate(),
        utils.sessions.getSpans.invalidate(),
        utils.sessions.getTraces.invalidate(),
      ]);
      toast.success({
        title: "Telemetry data cleared",
        description: `${result.traceCount} traces and ${result.spanCount} spans removed.`,
      });
    },
  });

  trpc.live.workspace.useSubscription(undefined, {
    onComplete() {
      setLiveStatus("offline");
    },
    onData() {
      setLiveStatus("live");
      void utils.telemetry.info.invalidate();
    },
    onError() {
      setLiveStatus("reconnecting");
    },
    onStarted() {
      setLiveStatus("live");
    },
  });

  const copyText = async (
    value: string,
    title: string,
    description: string,
  ) => {
    await navigator.clipboard.writeText(value);
    toast.success({
      title,
      description,
    });
  };

  const copyIngestUrl = () =>
    copyText(
      ingestUrl,
      "Ingest URL copied",
      "Paste it into your local agent telemetry config.",
    );

  return (
    <main className="min-h-screen bg-background text-foreground">
      <TraceTitleBar
        health={infoQuery.data?.lastBatch?.status ?? "waiting"}
        isRefreshing={isRefreshing}
        liveStatus={liveStatus}
        liveUrl={infoQuery.data?.liveUrl ?? "ws://127.0.0.1:8800"}
        onClearData={() => setClearDialogOpen(true)}
        onCopy={copyIngestUrl}
        onImport={() => undefined}
        onRefresh={refreshTelemetry}
        title="Trace Monitor"
      />

      <div className="grid min-h-[calc(100vh-3.5rem)] grid-cols-[14rem_minmax(0,1fr)] pt-14">
        <WorkspaceNav active="traces" />
        <section className="min-w-0 overflow-hidden">
          <ImportDataScreen
            onConnectLocalAgent={() => setLocalAgentSetupOpen(true)}
            onImportLangfuse={() => setImportDialogOpen(true)}
          />
        </section>
      </div>

      <LangfuseImportDialog
        onImported={refreshTelemetry}
        onOpenChange={setImportDialogOpen}
        open={importDialogOpen}
      />
      <LocalAgentSetupDialog
        envLine={catalystEnvLine}
        ingestUrl={ingestUrl}
        onOpenChange={setLocalAgentSetupOpen}
        open={localAgentSetupOpen}
      />
      <Dialog
        cancelTitle="Cancel"
        className="sm:!max-w-[520px] md:!w-[520px]"
        confirmButtonVariant="destructive"
        confirmTitle="Clear data"
        dialogDescription="This removes local traces, spans, search rows, ingest batches, and live telemetry history. Saved Langfuse connections stay intact."
        dialogTitle="Clear local telemetry data?"
        disabled={clearDataMutation.isPending}
        loading={clearDataMutation.isPending}
        onConfirm={() => clearDataMutation.mutate()}
        onOpenChange={setClearDialogOpen}
        open={clearDialogOpen}
      >
        <div className="rounded-md border border-destructive-border bg-destructive/5 p-4 text-sm">
          <div className="flex items-start gap-3">
            <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                This cannot be undone.
              </p>
              <p className="text-muted-foreground">
                Current local database contains {infoQuery.data?.traceCount ?? 0}{" "}
                traces and {infoQuery.data?.spanCount ?? 0} spans.
              </p>
            </div>
          </div>
        </div>
      </Dialog>
    </main>
  );
}
