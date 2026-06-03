import { createFileRoute } from "@tanstack/react-router";

import { TraceMonitorPage } from "~/tracing/TraceMonitorPage";

export const Route = createFileRoute("/")({
  component: TraceMonitorRoute,
  validateSearch: (search) => ({
    followLatest:
      search.followLatest === 1 || search.followLatest === "1" ? 1 : undefined,
    sessionId:
      typeof search.sessionId === "string" ? search.sessionId : undefined,
    traceId: typeof search.traceId === "string" ? search.traceId : undefined,
    view: search.view === "sessions" ? "sessions" : undefined,
  }),
});

function TraceMonitorRoute() {
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const viewMode = search.view === "sessions" ? "sessions" : "traces";

  return (
    <TraceMonitorPage
      followLatest={search.followLatest === 1}
      onFollowLatestChange={(followLatest) => {
        void navigate({
          search: {
            followLatest: followLatest ? 1 : undefined,
            sessionId: undefined,
            traceId: search.traceId,
            view: undefined,
          },
        });
      }}
      onSelectLatestTrace={(traceId) => {
        void navigate({
          replace: true,
          search: {
            followLatest: 1,
            sessionId: undefined,
            traceId,
            view: undefined,
          },
        });
      }}
      onSelectSession={(sessionId) => {
        void navigate({
          search: {
            followLatest: undefined,
            sessionId: sessionId ?? undefined,
            traceId: undefined,
            view: "sessions",
          },
        });
      }}
      onSelectTrace={(traceId) => {
        void navigate({
          search: {
            followLatest: undefined,
            sessionId: undefined,
            traceId: traceId ?? undefined,
            view: undefined,
          },
        });
      }}
      onOpenImportData={() => {
        void navigate({
          to: "/import-data",
        });
      }}
      onViewModeChange={(nextViewMode) => {
        void navigate({
          search:
            nextViewMode === "sessions"
              ? {
                  followLatest: undefined,
                  sessionId: undefined,
                  traceId: undefined,
                  view: "sessions",
                }
              : {
                  followLatest: undefined,
                  sessionId: undefined,
                  traceId: undefined,
                  view: undefined,
                },
        });
      }}
      selectedSessionId={viewMode === "sessions" ? search.sessionId : undefined}
      selectedTraceId={search.traceId}
      viewMode={viewMode}
    />
  );
}
