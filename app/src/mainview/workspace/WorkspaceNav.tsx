import { Link } from "@tanstack/react-router";
import { Activity, BrainCircuit, Settings } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/ui";

export type WorkspaceSection = "traces" | "analysis" | "settings";

const navItems: Array<{
  id: WorkspaceSection;
  icon: ReactNode;
  label: string;
  to: "/traces" | "/analysis" | "/settings";
}> = [
  {
    id: "traces",
    icon: <Activity className="h-4 w-4" strokeWidth={1.5} />,
    label: "Traces",
    to: "/traces",
  },
  {
    id: "analysis",
    icon: <BrainCircuit className="h-4 w-4" strokeWidth={1.5} />,
    label: "Analysis",
    to: "/analysis",
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
    <aside className="border-r border-border/50 bg-sidebar">
      <nav className="relative flex h-full overflow-y-auto py-2">
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
      </nav>
    </aside>
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
  to: "/traces" | "/analysis" | "/settings";
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
