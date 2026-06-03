import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Copy,
  DownloadCloud,
  RefreshCcw,
  Trash2,
} from "lucide-react";

import { Badge, Button, InferenceIcon, cn } from "~/lib/ui";

export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";

export function TraceTitleBar({
  followLatest,
  health,
  isRefreshing,
  liveStatus,
  liveUrl,
  onClearData,
  onCopy,
  onFollowLatestChange,
  onImport,
  onRefresh,
  title,
}: {
  followLatest?: boolean;
  health: string;
  isRefreshing: boolean;
  liveStatus: LiveStatus;
  liveUrl: string;
  onClearData: () => void;
  onCopy: () => void;
  onFollowLatestChange?: (enabled: boolean) => void;
  onImport?: () => void;
  onRefresh: () => void;
  title: string;
}) {
  return (
    <div className="electrobun-webkit-app-region-drag fixed inset-x-0 top-0 z-40 grid h-14 select-none grid-cols-[14rem_minmax(0,1fr)]">
      <div className="flex h-14 items-center border-r border-border/50 bg-sidebar px-5">
        <Link
          className="electrobun-webkit-app-region-no-drag"
          search={{} as never}
          to="/traces"
        >
          <InferenceIcon height={20} width={120} />
        </Link>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4 border-b border-border/50 bg-sidebar px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              HALO
            </p>
            <p className="truncate text-sm font-semibold">{title}</p>
          </div>
        </div>

        <div className="electrobun-webkit-app-region-no-drag flex min-w-0 items-center gap-2">
          <ToolbarStatus health={health} liveStatus={liveStatus} liveUrl={liveUrl} />
          {onFollowLatestChange ? (
            <Button
              aria-label={
                followLatest ? "Stop following latest trace" : "Follow latest trace"
              }
              aria-pressed={followLatest}
              className={cn(
                "gap-2",
                followLatest && "border-detail-brand/50 text-detail-brand",
              )}
              onClick={() => onFollowLatestChange(!followLatest)}
              size="sm"
              variant={followLatest ? "secondary" : "outline"}
            >
              <Activity
                className={cn("h-4 w-4", followLatest && "animate-pulse")}
              />
              {followLatest ? "Following latest" : "Follow latest"}
            </Button>
          ) : null}
          <Button
            aria-label="Open import data"
            asChild
            size="sm"
            variant="secondary"
          >
            <Link onClick={onImport} to="/import-data">
              <DownloadCloud className="mr-2 h-4 w-4" />
              Import Data
            </Link>
          </Button>
          <Button
            aria-label="Clear local telemetry data"
            className="border-destructive-border text-destructive hover:bg-destructive/10"
            onClick={onClearData}
            size="sm"
            variant="outline"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Clear Data
          </Button>
          <Button
            aria-label="Copy ingest URL"
            onClick={onCopy}
            size="sm"
            variant="outline"
          >
            <Copy className="mr-2 h-4 w-4" />
            Copy URL
          </Button>
          <Button
            aria-label="Refresh traces"
            onClick={onRefresh}
            size="icon"
            variant="ghost"
          >
            <RefreshCcw
              className={cn("h-4 w-4", isRefreshing && "animate-spin")}
            />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToolbarStatus({
  health,
  liveStatus,
  liveUrl,
}: {
  health: string;
  liveStatus: LiveStatus;
  liveUrl: string;
}) {
  const live = liveStatus === "live";
  const reconnecting = liveStatus === "reconnecting" || liveStatus === "connecting";
  const accepted = health === "accepted";
  const waiting = health === "waiting";
  const healthLabel = accepted
    ? "receiving telemetry"
    : waiting
      ? "waiting for telemetry"
      : health.replaceAll("_", " ");
  const liveLabel = live
    ? "live updates connected"
    : reconnecting
      ? "live updates connecting"
      : "live updates offline";
  const label = live
    ? accepted
      ? "Live ingest"
      : waiting
        ? "Live · waiting"
        : `Live · ${healthLabel}`
    : reconnecting
      ? "Connecting"
      : accepted
        ? "Ingest OK"
        : "Offline";
  const variant =
    live && accepted
      ? "status-success"
      : live || reconnecting
        ? "status-brand"
        : accepted
          ? "status-success"
          : "outline";
  return (
    <Badge
      className="gap-2"
      title={`Realtime: ${liveLabel}. Ingest: ${healthLabel}. Socket: ${liveUrl}`}
      variant={variant}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          live ? "bg-detail-brand" : "bg-muted-foreground",
          live && "animate-pulse",
        )}
      />
      {accepted ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : waiting ? (
        <AlertCircle className="h-3 w-3" />
      ) : null}
      {label}
    </Badge>
  );
}
