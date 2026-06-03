import { Bunqueue, type Job } from "bunqueue/client";
import type { DatabaseHandle } from "../db/client";
import type { LiveEventStore } from "../live/events";
import type { OtlpExportTraceServiceRequest } from "../telemetry/otlp";
import { ingestTelemetry } from "../telemetry/storage";
import { LangfuseApiClient, LangfuseApiError } from "./client";
import { langfuseTraceToOtlp, type LangfuseImportContext } from "./mapper";
import {
  createLangfuseImportJob,
  getLangfuseConnection,
  getLangfuseImportJob,
  isLangfuseImportCancelled,
  listLangfuseImportJobs,
  markInterruptedLangfuseImports,
  publishLangfuseImportJob,
  updateLangfuseImportJob,
} from "./storage";
import type {
  LangfuseImportJob,
  LangfuseObservation,
  LangfuseTraceFilters,
  LangfuseTraceListItem,
  LangfuseTraceWithDetails,
  StoredLangfuseConnection,
} from "./types";

type ImportJobData = {
  appJobId: string;
};

type ImportJobResult = {
  appJobId: string;
  cancelled?: boolean;
  importedTraces?: number;
};

type LangfuseImportServiceOptions = {
  database: DatabaseHandle;
  live: LiveEventStore;
};

export type LangfuseImportService = ReturnType<typeof createLangfuseImportService>;

const IMPORT_QUEUE_NAME = "langfuse-imports";
const IMPORT_ROUTE = "langfuse.import";
const TRACE_PAGE_LIMIT = 100;
const TRACE_LIST_FIELDS = "core,io,metadata,metrics";
const TRACE_DETAIL_FIELDS = "core,io,observations,metadata,metrics";
const OBSERVATION_FIELDS =
  "core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context";
const OBSERVATION_PAGE_LIMIT = 1000;
const OBSERVATION_TRACE_ID_CHUNK_SIZE = 100;
const OBSERVATION_CHUNK_CONCURRENCY = 8;
const LEGACY_OBSERVATION_PAGE_LIMIT = 100;
const LEGACY_OBSERVATION_PAGE_CONCURRENCY = 8;
const INGEST_BATCH_TRACE_LIMIT = 250;
const FALLBACK_TRACE_DETAIL_CONCURRENCY = 8;
const OBSERVATION_EXPAND_METADATA = [
  "function_name",
  "hidden_params",
  "litellm_model_name",
  "success",
];

export function createLangfuseImportService(options: LangfuseImportServiceOptions) {
  const { database, live } = options;
  markInterruptedLangfuseImports(database.sqlite);

  let queue: Bunqueue<ImportJobData, ImportJobResult>;
  queue = new Bunqueue<ImportJobData, ImportJobResult>(IMPORT_QUEUE_NAME, {
    concurrency: 1,
    dataPath: queueDataPath(database.path),
    heartbeatInterval: 2_000,
    defaultJobOptions: {
      durable: true,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
    dlq: {
      autoRetry: false,
      maxEntries: 500,
    },
    embedded: true,
    retry: {
      delay: 750,
      maxAttempts: 3,
      retryIf: (error) => isTransientImportError(error),
      strategy: "jitter",
    },
    routes: {
      [IMPORT_ROUTE]: async (job) =>
        processImportJob({
          database,
          job,
          live,
          queue,
        }),
    },
  });

  queue.on("failed", (job, error) => {
    const appJobId = job.data.appJobId;
    const current = getLangfuseImportJob(database.sqlite, appJobId);
    if (!current || current.status === "cancelled") return;
    const updated = updateLangfuseImportJob(database.sqlite, appJobId, {
      errorMessage: error.message,
      finishedAt: Date.now(),
      status: "failed",
    });
    publishLangfuseImportJob(live, updated);
  });

  return {
    async cancel(jobId: string) {
      const job = getLangfuseImportJob(database.sqlite, jobId);
      if (!job) return null;
      const updated = updateLangfuseImportJob(database.sqlite, jobId, {
        errorMessage: "Import cancelled by user.",
        finishedAt: Date.now(),
        status: "cancelled",
      });
      publishLangfuseImportJob(live, updated);
      if (job.bunqueueJobId) queue.cancel(job.bunqueueJobId);
      return updated;
    },

    close(force?: boolean) {
      return queue.close(force);
    },

    get(jobId: string) {
      return getLangfuseImportJob(database.sqlite, jobId);
    },

    list(limit?: number) {
      return listLangfuseImportJobs(database.sqlite, limit);
    },

    async start(input: {
      connectionId: string;
      filters: LangfuseTraceFilters;
    }): Promise<LangfuseImportJob> {
      const connection = getLangfuseConnection(database.sqlite, input.connectionId);
      if (!connection) throw new Error("Langfuse connection not found");

      const appJob = createLangfuseImportJob(database.sqlite, input);
      const queued = await queue.add(
        IMPORT_ROUTE,
        { appJobId: appJob.id },
        {
          durable: true,
          jobId: appJob.id,
          priority: 5,
        },
      );
      const updated = updateLangfuseImportJob(database.sqlite, appJob.id, {
        bunqueueJobId: queued.id,
        status: "queued",
      });
      publishLangfuseImportJob(live, updated);
      return updated;
    },
  };
}

async function processImportJob(input: {
  database: DatabaseHandle;
  job: Job<ImportJobData>;
  live: LiveEventStore;
  queue: Bunqueue<ImportJobData, ImportJobResult>;
}): Promise<ImportJobResult> {
  const { database, job, live, queue } = input;
  const appJobId = job.data.appJobId;
  const appJob = getLangfuseImportJob(database.sqlite, appJobId);
  if (!appJob || !["queued", "running"].includes(appJob.status)) {
    return { appJobId, cancelled: true };
  }

  const connection = getLangfuseConnection(database.sqlite, appJob.connectionId);
  if (!connection) {
    throw new Error("Langfuse connection not found");
  }

  const client = new LangfuseApiClient(connection);
  const signal = queue.getSignal(job.id) ?? undefined;
  const counters: ImportCounters = {
    failedTraces: appJob.failedTraces,
    importedObservations: appJob.importedObservations,
    importedTraces: appJob.importedTraces,
    processedTraces: appJob.importedTraces + appJob.failedTraces,
    totalObservations: appJob.totalObservations,
    totalTraces: appJob.totalTraces,
  };
  const startingProcessedTraces = counters.processedTraces;
  const context: LangfuseImportContext = {
    baseUrl: connection.baseUrl,
    connectionId: connection.id,
    connectionName: connection.name,
    importedAt: Date.now(),
    importJobId: appJobId,
  };

  await updateProgress({
    database,
    job,
    live,
    patch: {
      errorMessage: null,
      progress: 1,
      startedAt: Date.now(),
      status: "running",
    },
  });

  try {
    try {
      await importWithBatchedObservations({
        appJobId,
        client,
        connection,
        context,
        counters,
        database,
        filters: appJob.filters,
        job,
        live,
        signal,
      });
    } catch (error) {
      if (
        error instanceof FastPathUnsupportedError &&
        counters.processedTraces === startingProcessedTraces
      ) {
        await updateProgress({
          database,
          job,
          live,
          patch: {
            currentTraceId: null,
            currentTraceName: "Falling back to observations",
            progress: progressFor(counters.processedTraces, counters.totalTraces),
          },
        });
        try {
          await importWithLegacyObservations({
            appJobId,
            client,
            connection,
            context,
            counters,
            database,
            filters: appJob.filters,
            job,
            live,
            signal,
          });
        } catch (legacyError) {
          if (
            isLegacyObservationsUnsupportedError(legacyError) &&
            counters.processedTraces === startingProcessedTraces
          ) {
            await updateProgress({
              database,
              job,
              live,
              patch: {
                currentTraceId: null,
                currentTraceName: "Falling back to trace details",
                progress: progressFor(
                  counters.processedTraces,
                  counters.totalTraces,
                ),
              },
            });
            await importWithTraceDetails({
              appJobId,
              client,
              connection,
              context,
              counters,
              database,
              filters: appJob.filters,
              job,
              live,
              signal,
            });
          } else {
            throw legacyError;
          }
        }
      } else {
        throw error;
      }
    }

    const complete = updateLangfuseImportJob(database.sqlite, appJobId, {
      currentTraceId: null,
      currentTraceName: null,
      finishedAt: Date.now(),
      progress: 100,
      status: "completed",
    });
    await job.updateProgress(100, "Import complete");
    publishLangfuseImportJob(live, complete);
    return { appJobId, importedTraces: counters.importedTraces };
  } catch (error) {
    if (
      error instanceof ImportCancelledError ||
      isCancelled(database, appJobId, signal) ||
      isAbortError(error)
    ) {
      await markCancelled({ database, job, live });
      return { appJobId, cancelled: true };
    }
    const message = error instanceof Error ? error.message : "Import failed";
    const failed = updateLangfuseImportJob(database.sqlite, appJobId, {
      errorMessage: message,
      finishedAt: Date.now(),
      status: "failed",
    });
    publishLangfuseImportJob(live, failed);
    throw error;
  }
}

type ImportCounters = {
  failedTraces: number;
  importedObservations: number;
  importedTraces: number;
  processedTraces: number;
  totalObservations: number;
  totalTraces: number;
};

type ImportPipelineInput = {
  appJobId: string;
  client: LangfuseApiClient;
  connection: StoredLangfuseConnection;
  context: LangfuseImportContext;
  counters: ImportCounters;
  database: DatabaseHandle;
  filters: LangfuseTraceFilters;
  job: Job<ImportJobData>;
  live: LiveEventStore;
  signal?: AbortSignal;
};

class ImportCancelledError extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "ImportCancelledError";
  }
}

class FastPathUnsupportedError extends Error {
  constructor(
    message: string,
    readonly originalError: unknown,
  ) {
    super(message);
    this.name = "FastPathUnsupportedError";
  }
}

class LegacyObservationsUnsupportedError extends Error {
  constructor(
    message: string,
    readonly originalError: unknown,
  ) {
    super(message);
    this.name = "LegacyObservationsUnsupportedError";
  }
}

async function importWithBatchedObservations(input: ImportPipelineInput) {
  let page = 1;
  while (true) {
    assertNotCancelled(input.database, input.appJobId, input.signal);

    const list = await input.client.listTraces(
      {
        fields: TRACE_LIST_FIELDS,
        filters: input.filters,
        limit: TRACE_PAGE_LIMIT,
        orderBy: "timestamp.asc",
        page,
      },
      input.signal,
    );
    const traces = list.data ?? [];
    input.counters.totalTraces = list.meta?.totalItems ?? input.counters.totalTraces;

    await updateCountersProgress(input, {
      progress: progressFor(
        input.counters.processedTraces,
        input.counters.totalTraces,
      ),
    });

    if (traces.length === 0) break;

    const observationsByTraceId = await listObservationsForTraceIds({
      client: input.client,
      filters: input.filters,
      signal: input.signal,
      traceIds: traces.map((trace) => trace.id),
    });
    const detailedTraces = traces.map((trace) =>
      attachObservations(trace, observationsByTraceId),
    );

    await ingestTraceBatches({
      ...input,
      traces: detailedTraces,
    });

    const totalPages = list.meta?.totalPages;
    if (totalPages != null && page >= totalPages) break;
    if (traces.length < TRACE_PAGE_LIMIT) break;
    page += 1;
  }
}

async function importWithLegacyObservations(input: ImportPipelineInput) {
  assertNotCancelled(input.database, input.appJobId, input.signal);

  let firstPage;
  try {
    firstPage = await input.client.listObservations(
      {
        fromStartTime: input.filters.fromTimestamp,
        limit: LEGACY_OBSERVATION_PAGE_LIMIT,
        page: 1,
        toStartTime: input.filters.toTimestamp,
      },
      input.signal,
    );
  } catch (error) {
    if (isFastPathUnsupportedError(error)) {
      throw new LegacyObservationsUnsupportedError(
        "Langfuse legacy observations are unavailable.",
        error,
      );
    }
    throw error;
  }

  const observations = [...(firstPage.data ?? [])];
  const totalPages = firstPage.meta?.totalPages ?? (observations.length > 0 ? 1 : 0);
  input.counters.totalObservations = Math.max(
    input.counters.totalObservations,
    firstPage.meta?.totalItems ?? observations.length,
  );

  await updateCountersProgress(input, {
    progress: progressFor(input.counters.processedTraces, input.counters.totalTraces),
  });

  const traceItemsPromise = listAllTraceItems(input);
  const remainingPages = Array.from(
    { length: Math.max(0, totalPages - 1) },
    (_, index) => index + 2,
  );
  const pages = await mapWithConcurrency(
    remainingPages,
    LEGACY_OBSERVATION_PAGE_CONCURRENCY,
    async (page) => {
      assertNotCancelled(input.database, input.appJobId, input.signal);
      const response = await input.client.listObservations(
        {
          fromStartTime: input.filters.fromTimestamp,
          limit: LEGACY_OBSERVATION_PAGE_LIMIT,
          page,
          toStartTime: input.filters.toTimestamp,
        },
        input.signal,
      );
      return response.data ?? [];
    },
  );

  for (const page of pages) observations.push(...page);

  const observationsByTraceId = groupObservationsByTraceId(observations);
  const traceItems = await traceItemsPromise;
  const tracesById = new Map<string, LangfuseTraceWithDetails>();
  for (const trace of traceItems) {
    tracesById.set(trace.id, attachObservations(trace, observationsByTraceId));
  }
  for (const trace of tracesFromLegacyObservations(observations)) {
    if (!tracesById.has(trace.id)) tracesById.set(trace.id, trace);
  }

  const traces = [...tracesById.values()];
  input.counters.totalTraces = traces.length;

  await ingestTraceBatches({
    ...input,
    traces,
  });
}

async function listAllTraceItems(
  input: Pick<ImportPipelineInput, "client" | "filters" | "signal">,
) {
  const first = await input.client.listTraces(
    {
      fields: TRACE_LIST_FIELDS,
      filters: input.filters,
      limit: TRACE_PAGE_LIMIT,
      orderBy: "timestamp.asc",
      page: 1,
    },
    input.signal,
  );
  const traces = [...(first.data ?? [])];
  const totalPages = first.meta?.totalPages ?? (traces.length > 0 ? 1 : 0);
  const remainingPages = Array.from(
    { length: Math.max(0, totalPages - 1) },
    (_, index) => index + 2,
  );
  const pages = await mapWithConcurrency(
    remainingPages,
    LEGACY_OBSERVATION_PAGE_CONCURRENCY,
    async (page) => {
      const response = await input.client.listTraces(
        {
          fields: TRACE_LIST_FIELDS,
          filters: input.filters,
          limit: TRACE_PAGE_LIMIT,
          orderBy: "timestamp.asc",
          page,
        },
        input.signal,
      );
      return response.data ?? [];
    },
  );
  for (const page of pages) traces.push(...page);
  return traces;
}

async function importWithTraceDetails(input: ImportPipelineInput) {
  let page = 1;
  while (true) {
    assertNotCancelled(input.database, input.appJobId, input.signal);

    const list = await input.client.listTraces(
      {
        fields: TRACE_LIST_FIELDS,
        filters: input.filters,
        limit: TRACE_PAGE_LIMIT,
        orderBy: "timestamp.asc",
        page,
      },
      input.signal,
    );
    const traces = list.data ?? [];
    input.counters.totalTraces = list.meta?.totalItems ?? input.counters.totalTraces;

    await updateCountersProgress(input, {
      progress: progressFor(
        input.counters.processedTraces,
        input.counters.totalTraces,
      ),
    });

    if (traces.length === 0) break;

    const fetched = await mapWithConcurrency(
      traces,
      FALLBACK_TRACE_DETAIL_CONCURRENCY,
      async (listedTrace) => {
        assertNotCancelled(input.database, input.appJobId, input.signal);
        try {
          const trace = await input.client.getTrace(listedTrace.id, input.signal, {
            fields: TRACE_DETAIL_FIELDS,
          });
          return { trace };
        } catch (error) {
          if (
            isCancelled(input.database, input.appJobId, input.signal) ||
            isAbortError(error)
          ) {
            throw new ImportCancelledError();
          }
          return { failedTrace: listedTrace };
        }
      },
    );

    const detailedTraces: LangfuseTraceWithDetails[] = [];
    for (const result of fetched) {
      if (result.trace) {
        detailedTraces.push(result.trace);
      } else {
        input.counters.failedTraces += 1;
        input.counters.processedTraces += 1;
      }
    }

    if (detailedTraces.length > 0) {
      await ingestTraceBatches({
        ...input,
        traces: detailedTraces,
      });
    } else {
      await updateCountersProgress(input, {
        progress: progressFor(
          input.counters.processedTraces,
          input.counters.totalTraces,
        ),
      });
    }

    const totalPages = list.meta?.totalPages;
    if (totalPages != null && page >= totalPages) break;
    if (traces.length < TRACE_PAGE_LIMIT) break;
    page += 1;
  }
}

async function listObservationsForTraceIds(input: {
  client: LangfuseApiClient;
  filters: LangfuseTraceFilters;
  signal?: AbortSignal;
  traceIds: string[];
}) {
  const observationsByTraceId = new Map<string, LangfuseObservation[]>();
  const chunks = chunkArray(
    input.traceIds,
    OBSERVATION_TRACE_ID_CHUNK_SIZE,
  ).filter((chunk) => chunk.length > 0);

  await mapWithConcurrency(chunks, OBSERVATION_CHUNK_CONCURRENCY, async (traceIds) => {
    let cursor: string | null | undefined;
    do {
      try {
        const response = await input.client.listObservationsV2(
          {
            cursor,
            expandMetadata: OBSERVATION_EXPAND_METADATA,
            fields: OBSERVATION_FIELDS,
            fromStartTime: input.filters.fromTimestamp,
            limit: OBSERVATION_PAGE_LIMIT,
            toStartTime: input.filters.toTimestamp,
            traceIds,
          },
          input.signal,
        );

        const observations = response.data ?? [];
        for (const observation of observations) {
          if (!observation.traceId) continue;
          const grouped = observationsByTraceId.get(observation.traceId) ?? [];
          grouped.push(observation);
          observationsByTraceId.set(observation.traceId, grouped);
        }
        cursor = response.meta?.cursor ?? null;
      } catch (error) {
        if (isFastPathUnsupportedError(error)) {
          throw new FastPathUnsupportedError(
            "Langfuse observations v2 is unavailable; falling back to trace details.",
            error,
          );
        }
        throw error;
      }
    } while (cursor);
  });

  return observationsByTraceId;
}

function attachObservations(
  trace: LangfuseTraceListItem,
  observationsByTraceId: Map<string, LangfuseObservation[]>,
): LangfuseTraceWithDetails {
  return {
    ...trace,
    observations: observationsByTraceId.get(trace.id) ?? [],
  };
}

function tracesFromLegacyObservations(
  observations: LangfuseObservation[],
): LangfuseTraceWithDetails[] {
  return [...groupObservationsByTraceId(observations).entries()].map(
    ([traceId, traceObservations]) =>
      traceFromLegacyObservations(traceId, traceObservations),
  );
}

function groupObservationsByTraceId(observations: LangfuseObservation[]) {
  const observationsByTraceId = new Map<string, LangfuseObservation[]>();
  for (const observation of observations) {
    if (!observation.traceId) continue;
    const grouped = observationsByTraceId.get(observation.traceId) ?? [];
    grouped.push(observation);
    observationsByTraceId.set(observation.traceId, grouped);
  }
  return observationsByTraceId;
}

function traceFromLegacyObservations(
  traceId: string,
  observations: LangfuseObservation[],
): LangfuseTraceWithDetails {
  const sorted = [...observations].sort((a, b) => {
    const at = Date.parse(a.startTime ?? "");
    const bt = Date.parse(b.startTime ?? "");
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
  });
  const root =
    sorted.find((observation) => !observation.parentObservationId) ?? sorted[0];
  return {
    environment: root?.environment ?? null,
    id: traceId,
    metadata: legacyTraceMetadata(root),
    name: root?.name ?? "Langfuse trace",
    observations: sorted,
    timestamp: root?.startTime,
    version: root?.version ?? null,
  };
}

function legacyTraceMetadata(observation: LangfuseObservation | undefined) {
  const metadata = objectRecord(observation?.metadata);
  const attributes = {
    ...objectRecord(metadata.attributes),
    "agent.name":
      objectRecord(metadata.attributes)["agent.name"] ??
      observation?.name ??
      "Langfuse trace",
  };
  const resourceAttributes = {
    ...objectRecord(metadata.resourceAttributes),
    "deployment.environment":
      objectRecord(metadata.resourceAttributes)["deployment.environment"] ??
      observation?.environment ??
      "",
    "service.name":
      objectRecord(metadata.resourceAttributes)["service.name"] ??
      observation?.name ??
      "langfuse-import",
    "service.version":
      objectRecord(metadata.resourceAttributes)["service.version"] ??
      observation?.version ??
      "",
  };

  return {
    ...metadata,
    attributes,
    resourceAttributes,
  };
}

async function ingestTraceBatches(
  input: ImportPipelineInput & { traces: LangfuseTraceWithDetails[] },
) {
  for (
    let start = 0;
    start < input.traces.length;
    start += INGEST_BATCH_TRACE_LIMIT
  ) {
    assertNotCancelled(input.database, input.appJobId, input.signal);
    const batch = input.traces.slice(start, start + INGEST_BATCH_TRACE_LIMIT);
    const currentTrace = batch[0] ?? null;

    await updateCountersProgress(input, {
      currentTraceId: currentTrace?.id ?? null,
      currentTraceName: currentTrace?.name ?? null,
      progress: progressFor(
        input.counters.processedTraces,
        input.counters.totalTraces,
      ),
    });

    const outcome = ingestTraceBatch(input.database, batch, input.context);
    input.counters.failedTraces += outcome.failedTraces;
    input.counters.importedObservations += outcome.acceptedSpanCount;
    input.counters.importedTraces += outcome.importedTraces;
    input.counters.processedTraces += batch.length;
    input.counters.totalObservations = Math.max(
      input.counters.totalObservations,
      input.counters.importedObservations,
    );

    const lastTrace = batch.at(-1) ?? currentTrace;
    await updateCountersProgress(input, {
      currentTraceId: lastTrace?.id ?? null,
      currentTraceName: lastTrace?.name ?? null,
      progress: progressFor(
        input.counters.processedTraces,
        input.counters.totalTraces,
      ),
    });
  }
}

function ingestTraceBatch(
  database: DatabaseHandle,
  traces: LangfuseTraceWithDetails[],
  context: LangfuseImportContext,
) {
  try {
    const result = ingestOtlpPayload(database, traces, context);
    return {
      acceptedSpanCount: result.acceptedSpanCount,
      failedTraces: 0,
      importedTraces: traces.length,
    };
  } catch {
    let acceptedSpanCount = 0;
    let failedTraces = 0;
    let importedTraces = 0;
    for (const trace of traces) {
      try {
        const result = ingestOtlpPayload(database, [trace], context);
        acceptedSpanCount += result.acceptedSpanCount;
        importedTraces += 1;
      } catch {
        failedTraces += 1;
      }
    }
    return { acceptedSpanCount, failedTraces, importedTraces };
  }
}

function ingestOtlpPayload(
  database: DatabaseHandle,
  traces: LangfuseTraceWithDetails[],
  context: LangfuseImportContext,
) {
  const body = JSON.stringify(combineTracePayloads(traces, context));
  return ingestTelemetry(
    database.sqlite,
    {
      body,
      contentEncoding: "langfuse-import",
      searchMode: "compact",
      sizeBytes: Buffer.byteLength(body),
    },
  );
}

function combineTracePayloads(
  traces: LangfuseTraceWithDetails[],
  context: LangfuseImportContext,
): OtlpExportTraceServiceRequest {
  return {
    resourceSpans: traces.flatMap(
      (trace) => langfuseTraceToOtlp(trace, context).resourceSpans ?? [],
    ),
  };
}

async function updateCountersProgress(
  input: Pick<ImportPipelineInput, "counters" | "database" | "job" | "live">,
  patch: Parameters<typeof updateLangfuseImportJob>[2] = {},
) {
  await updateProgress({
    database: input.database,
    job: input.job,
    live: input.live,
    patch: {
      failedTraces: input.counters.failedTraces,
      importedObservations: input.counters.importedObservations,
      importedTraces: input.counters.importedTraces,
      totalObservations: input.counters.totalObservations,
      totalTraces: input.counters.totalTraces,
      ...patch,
    },
  });
}

async function updateProgress(input: {
  database: DatabaseHandle;
  job: Job<ImportJobData>;
  live: LiveEventStore;
  patch: Parameters<typeof updateLangfuseImportJob>[2];
}) {
  await renewJobLock(input.job);
  const updated = updateLangfuseImportJob(
    input.database.sqlite,
    input.job.data.appJobId,
    input.patch,
  );
  if (input.patch.progress != null) {
    await input.job.updateProgress(
      input.patch.progress,
      updated.currentTraceName ?? updated.status,
    );
  }
  publishLangfuseImportJob(input.live, updated);
}

async function renewJobLock(job: Job<ImportJobData>) {
  const lockableJob = job as Job<ImportJobData> & { token?: string };
  if (!lockableJob.token) return;
  await job.extendLock(lockableJob.token, 10 * 60 * 1000).catch(() => {});
}

async function markCancelled(input: {
  database: DatabaseHandle;
  job: Job<ImportJobData>;
  live: LiveEventStore;
}) {
  const updated = updateLangfuseImportJob(
    input.database.sqlite,
    input.job.data.appJobId,
    {
      errorMessage: "Import cancelled by user.",
      finishedAt: Date.now(),
      status: "cancelled",
    },
  );
  await input.job.updateProgress(updated.progress, "Import cancelled");
  publishLangfuseImportJob(input.live, updated);
}

function isCancelled(
  database: DatabaseHandle,
  appJobId: string,
  signal: AbortSignal | undefined,
) {
  return signal?.aborted || isLangfuseImportCancelled(database.sqlite, appJobId);
}

function assertNotCancelled(
  database: DatabaseHandle,
  appJobId: string,
  signal: AbortSignal | undefined,
) {
  if (isCancelled(database, appJobId, signal)) {
    throw new ImportCancelledError();
  }
}

function progressFor(processedTraces: number, totalTraces: number) {
  if (totalTraces <= 0) return processedTraces > 0 ? 95 : 5;
  return Math.min(99, Math.max(5, Math.floor((processedTraces / totalTraces) * 100)));
}

function isTransientImportError(error: Error) {
  if (error instanceof LangfuseApiError) {
    return error.status === 429 || (error.status != null && error.status >= 500);
  }
  return true;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isFastPathUnsupportedError(error: unknown) {
  if (!(error instanceof LangfuseApiError)) return false;
  return (
    error.status === 400 ||
    error.status === 404 ||
    error.status === 405 ||
    error.status === 414 ||
    error.status === 422
  );
}

function isLegacyObservationsUnsupportedError(error: unknown) {
  return error instanceof LegacyObservationsUnsupportedError;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function queueDataPath(databasePath: string) {
  return databasePath === ":memory:" ? ":memory:" : `${databasePath}.bunqueue.sqlite`;
}
