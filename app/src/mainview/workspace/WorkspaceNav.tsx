import { Link } from "@tanstack/react-router";
import {
  Activity,
  BookOpen,
  BrainCircuit,
  DownloadCloud,
  Settings,
  Star,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button, InferenceIcon, cn } from "~/lib/ui";
import { compactNumber } from "~/lib/format";
import { isDesktopShell, openExternalUrl } from "~/desktop/desktopBridge";
import { trpc } from "~/trpc";
import {
  APP_CATALYST_URL,
  APP_DOCS_URL,
  APP_GITHUB_URL,
  APP_INFERENCE_LOGO_URL,
} from "../../desktop/commands";

export type WorkspaceSection = "data" | "analysis" | "imports" | "settings";

const navItems: Array<{
  id: WorkspaceSection;
  icon: ReactNode;
  label: string;
  to: "/data" | "/analysis" | "/imports" | "/settings";
}> = [
  {
    id: "data",
    icon: <Activity className="h-4 w-4" strokeWidth={1.5} />,
    label: "Data",
    to: "/data",
  },
  {
    id: "analysis",
    icon: <BrainCircuit className="h-4 w-4" strokeWidth={1.5} />,
    label: "Analysis",
    to: "/analysis",
  },
  {
    id: "imports",
    icon: <DownloadCloud className="h-4 w-4" strokeWidth={1.5} />,
    label: "Imports",
    to: "/imports",
  },
  {
    id: "settings",
    icon: <Settings className="h-4 w-4" strokeWidth={1.5} />,
    label: "Settings",
    to: "/settings",
  },
];

export function WorkspaceNav({ active }: { active: WorkspaceSection }) {
  return (
    <aside className="flex flex-col border-r border-border/50 bg-sidebar">
      {/* In the desktop shell the brand sits below the macOS traffic lights
          (the empty header strip above), aligned with the nav item icons. In
          a browser the wordmark stays in the AppHeader instead. */}
      {isDesktopShell() ? (
        <div className="flex-none px-6 pb-3">
          <button
            aria-label="Open Inference"
            className="electrobun-webkit-app-region-no-drag inline-flex"
            onClick={() => void openExternalUrl(APP_INFERENCE_LOGO_URL)}
            type="button"
          >
            <InferenceIcon height={20} width={120} />
          </button>
        </div>
      ) : null}
      <nav className="relative flex min-h-0 flex-1 flex-col overflow-y-auto pb-3">
        <ul className="w-full">
          {navItems.map((item) => (
            <WorkspaceNavLink
              active={active === item.id}
              icon={item.icon}
              key={item.id}
              label={item.label}
              to={item.to}
            />
          ))}
        </ul>
        <WorkspaceResourceLinks />
      </nav>
    </aside>
  );
}

function WorkspaceResourceLinks() {
  const starsQuery = trpc.github.stars.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60 * 60 * 1000,
  });

  return (
    <div className="mt-auto space-y-2 px-3 pt-4">
      <WorkspaceResourceButton
        href={APP_DOCS_URL}
        icon={<BookOpen className="h-4 w-4" />}
        label="Documentation"
      />
      <WorkspaceResourceButton
        href={APP_GITHUB_URL}
        icon={<GitHubMark className="h-4 w-4" />}
        label={
          <>
            <span>View GitHub</span>
            {starsQuery.data != null ? (
              <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                <Star className="h-3.5 w-3.5 fill-amber-500/70 text-amber-500/70" />
                {compactNumber(starsQuery.data)}
              </span>
            ) : null}
          </>
        }
      />
      <WorkspaceResourceButton
        href={APP_CATALYST_URL}
        icon={<SparklesMark className="h-4 w-4" />}
        label="Upgrade - $250 Free"
      />
    </div>
  );
}

function WorkspaceResourceButton({
  href,
  icon,
  label,
}: {
  href: string;
  icon: ReactNode;
  label: ReactNode;
}) {
  return (
    <Button
      className="electrobun-webkit-app-region-no-drag w-full justify-start gap-2"
      onClick={() => void openExternalUrl(href)}
      size="sm"
      type="button"
      variant="outline"
    >
      {icon}
      {label}
    </Button>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 2C6.477 2 2 6.486 2 12.02c0 4.43 2.865 8.185 6.839 9.513.5.092.682-.217.682-.482 0-.237-.009-.866-.014-1.7-2.782.605-3.369-1.343-3.369-1.343-.455-1.158-1.11-1.467-1.11-1.467-.908-.62.069-.608.069-.608 1.004.071 1.532 1.033 1.532 1.033.892 1.53 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.338-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.987 1.03-2.687-.103-.253-.447-1.27.098-2.647 0 0 .84-.27 2.75 1.026A9.56 9.56 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.026 2.747-1.026.546 1.377.202 2.394.1 2.647.64.7 1.028 1.594 1.028 2.687 0 3.848-2.338 4.695-4.566 4.943.36.31.68.923.68 1.86 0 1.343-.012 2.427-.012 2.757 0 .267.18.578.688.48C19.138 20.2 22 16.448 22 12.02 22 6.486 17.523 2 12 2Z" />
    </svg>
  );
}

function SparklesMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
    >
      <path
        d="M12 3.5 14.15 9 19.5 11.15 14.15 13.3 12 18.5 9.85 13.3 4.5 11.15 9.85 9 12 3.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M18.5 4.5 19.35 6.65 21.5 7.5 19.35 8.35 18.5 10.5 17.65 8.35 15.5 7.5 17.65 6.65 18.5 4.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function WorkspaceNavLink({
  active,
  icon,
  label,
  to,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  to: "/data" | "/analysis" | "/imports" | "/settings";
}) {
  return (
    <li className="px-3 py-px">
      <Link
        className={cn(
          "electrobun-webkit-app-region-no-drag flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground hover:bg-accent hover:text-foreground",
          active && "bg-accent text-foreground",
        )}
        search={{} as never}
        to={to}
      >
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}
