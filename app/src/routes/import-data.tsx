import { createFileRoute } from "@tanstack/react-router";

import { ImportDataRoutePage } from "~/tracing/ImportDataRoutePage";

export const Route = createFileRoute("/import-data")({
  component: ImportDataRoutePage,
});
