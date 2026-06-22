import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createDatabase, ensureSchema } from "../src/server/db/client";
import {
  demoTracesCacheRoot,
  downloadDemoTraces,
  huggingFaceDemoTracesUrl,
} from "../src/server/fileimport/demoTraces";
import { createFileImportService } from "../src/server/fileimport/importQueue";
import {
  jsonlSpansToOtlp,
  previewJsonlFile,
  streamJsonlSpans,
} from "../src/server/fileimport/parser";
import { getFileImportJob } from "../src/server/fileimport/storage";
import type { JsonlSpanRecord } from "../src/server/fileimport/types";
import { exportHaloTraceJsonl } from "../src/server/halo/exporter";
import { createLiveEventStore } from "../src/server/live/events";
import {
  getSpansForTrace,
  getTrace,
  ingestTelemetry,
  listTraces,
} from "../src/server/telemetry/storage";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function writeJsonl(lines: Array<unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "halo-fileimport-"));
  tempDirs.push(dir);
  const path = join(dir, "traces.jsonl");
  const content = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  writeFileSync(path, `${content}\n`, "utf8");
  return path;
}

function writeGzippedJsonl(lines: Array<unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "halo-fileimport-"));
  tempDirs.push(dir);
  const path = join(dir, "traces.jsonl.gz");
  const content = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  writeFileSync(path, gzipSync(`${content}\n`));
  return path;
}

describe("JSONL parser", () => {
  test("streams spans and reports invalid lines", async () => {
    const path = writeJsonl([
      makeSpanRecord({ span_id: "aaaaaaaaaaaaaaaa" }),
      "not json at all",
      JSON.stringify({ trace_id: "nope", span_id: "bad" }),
      makeSpanRecord({ parent_span_id: "aaaaaaaaaaaaaaaa", span_id: "bbbbbbbbbbbbbbbb" }),
      "",
    ]);

    const invalid: Array<{ line: number; reason: string }> = [];
    const spans: string[] = [];
    for await (const { record } of streamJsonlSpans(path, (line, reason) =>
      invalid.push({ line, reason }),
    )) {
      spans.push(record.span_id);
    }

    expect(spans).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(invalid).toHaveLength(2);
    expect(invalid[0]?.reason).toContain("JSON");
    expect(invalid[1]?.reason).toContain("trace_id");
  });

  test("previews exact counts in one pass", async () => {
    const path = writeJsonl([
      makeSpanRecord({
        attributes: { "session.id": "session-1" },
        span_id: "aaaaaaaaaaaaaaaa",
      }),
      makeSpanRecord({
        attributes: { "session.id": "session-2" },
        span_id: "bbbbbbbbbbbbbbbb",
      }),
      makeSpanRecord({
        resource: { attributes: { "service.name": "other-service" } },
        span_id: "cccccccccccccccc",
        trace_id: "fedcba9876543210fedcba9876543210",
      }),
      "broken line",
    ]);

    const preview = await previewJsonlFile(path);
    expect(preview.traces).toBe(2);
    expect(preview.observations).toBe(3);
    expect(preview.sessions).toBe(2);
    expect(preview.invalidLines).toBe(1);
    expect(preview.serviceNames).toEqual(["gator-agent", "other-service"]);
    expect(preview.fileName).toBe("traces.jsonl");
  });

  test("previews gzipped JSONL exports", async () => {
    const path = writeGzippedJsonl([
      makeSpanRecord({
        attributes: { "session.id": "session-1" },
        span_id: "aaaaaaaaaaaaaaaa",
      }),
      makeSpanRecord({
        parent_span_id: "aaaaaaaaaaaaaaaa",
        span_id: "bbbbbbbbbbbbbbbb",
      }),
    ]);

    const preview = await previewJsonlFile(path);
    expect(preview.fileName).toBe("traces.jsonl.gz");
    expect(preview.traces).toBe(1);
    expect(preview.observations).toBe(2);
    expect(preview.sessions).toBe(1);
  });

  test("rejects files with no importable spans", async () => {
    const path = writeJsonl(["nope", "{}"]);
    expect(previewJsonlFile(path)).rejects.toThrow("invalid");
  });

  test("maps records to OTLP with provenance and orphan-parent handling", () => {
    const records = [
      makeSpanRecord({ span_id: "aaaaaaaaaaaaaaaa" }),
      makeSpanRecord({
        attributes: {
          "int.llm.token_count.total": 30,
          "llm.model_name": "claude-sonnet-4-6",
          "null.attribute": null,
        },
        parent_span_id: "aaaaaaaaaaaaaaaa",
        span_id: "bbbbbbbbbbbbbbbb",
      }),
      makeSpanRecord({
        parent_span_id: "9999999999999999",
        span_id: "cccccccccccccccc",
      }),
    ];
    const otlp = jsonlSpansToOtlp(records, {
      fileName: "traces.jsonl",
      importedAt: "2026-06-12T00:00:00.000Z",
      importJobId: "job-1",
    });

    const spans = otlp.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
    expect(spans).toHaveLength(3);
    expect(spans[1]?.parentSpanId).toBe("aaaaaaaaaaaaaaaa");
    // Parent outside the file is dropped so the span still renders in trees.
    expect(spans[2]?.parentSpanId).toBeUndefined();
    const attrs = spans[1]?.attributes ?? [];
    // HALO-exporter "int." prefixes are stripped back to plain keys.
    expect(
      attrs.some(
        (a) => a.key === "llm.token_count.total" && a.value?.intValue === 30,
      ),
    ).toBe(true);
    expect(attrs.some((a) => a.key.startsWith("int."))).toBe(false);
    expect(attrs.some((a) => a.key === "null.attribute")).toBe(false);
    for (const span of spans) {
      expect(
        span.attributes?.some(
          (a) => a.key === "halo.source" && a.value?.stringValue === "file",
        ),
      ).toBe(true);
      expect(
        span.attributes?.some(
          (a) =>
            a.key === "halo.source.connection_name" &&
            a.value?.stringValue === "traces.jsonl",
        ),
      ).toBe(true);
    }
  });

  test("preserves sub-millisecond timestamp precision", () => {
    const records = [
      makeSpanRecord({
        end_time: "2026-05-27T21:53:58.757746470Z",
        span_id: "aaaaaaaaaaaaaaaa",
        start_time: "2026-05-27T21:53:50.930000000Z",
      }),
    ];
    const span = jsonlSpansToOtlp(records).resourceSpans?.[0]?.scopeSpans?.[0]
      ?.spans?.[0];
    expect(span?.startTimeUnixNano).toBe("1779918830930000000");
    expect(span?.endTimeUnixNano).toBe("1779918838757746470");
  });
});

describe("Demo traces download helper", () => {
  test("builds deterministic allowlisted Hugging Face resolve URLs", () => {
    expect(huggingFaceDemoTracesUrl("halo_search_agent_1000_traces.jsonl")).toBe(
      "https://huggingface.co/datasets/inference-net/SearchAgentDemoTraces/resolve/6dd8e0422939749a5e839a6e1bda4291e4ca5e56/halo_search_agent_1000_traces.jsonl",
    );
  });

  test("places demo cache beside the local database", () => {
    expect(demoTracesCacheRoot("/tmp/halo/data/halo.sqlite")).toBe(
      "/tmp/halo/data/cache/demo-traces",
    );
    expect(demoTracesCacheRoot(":memory:")).toContain("halo-demo-traces-cache");
  });

  test("downloads an allowlisted file and reuses the cache", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "halo-demo-cache-"));
    tempDirs.push(cacheRoot);
    const body = Buffer.from(`${JSON.stringify(makeSpanRecord())}\n`);
    const progress: number[] = [];
    const calls: string[] = [];

    const result = await downloadDemoTraces({
      cacheRoot,
      fetcher: async (url) => {
        calls.push(url);
        return new Response(body, {
          headers: { "content-length": String(body.byteLength) },
          status: 200,
        });
      },
      onProgress: ({ downloadedBytes }) => progress.push(downloadedBytes),
    });

    expect(result.cached).toBe(false);
    expect(result.downloadedBytes).toBe(body.byteLength);
    expect(result.totalBytes).toBe(body.byteLength);
    expect(calls).toEqual([
      huggingFaceDemoTracesUrl("halo_search_agent_1000_traces.jsonl"),
    ]);
    expect(Buffer.compare(readFileSync(result.filePath), body)).toBe(0);
    expect(progress.at(-1)).toBe(body.byteLength);

    const cached = await downloadDemoTraces({
      cacheRoot,
      fetcher: async () => {
        throw new Error("network should not be used");
      },
    });
    expect(cached.cached).toBe(true);
    expect(cached.filePath).toBe(result.filePath);
    expect(cached.fileSizeBytes).toBe(body.byteLength);
  });

  test("reports a missing allowlisted dataset file", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "halo-demo-cache-"));
    tempDirs.push(cacheRoot);
    const calls: string[] = [];

    await expect(
      downloadDemoTraces({
        cacheRoot,
        fetcher: async (url) => {
          calls.push(url);
          return new Response("missing", { status: 404 });
        },
      }),
    ).rejects.toThrow("HTTP 404");
    expect(calls).toEqual([
      huggingFaceDemoTracesUrl("halo_search_agent_1000_traces.jsonl"),
    ]);
  });

  test("reports non-200 download failures without network dependency", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "halo-demo-cache-"));
    tempDirs.push(cacheRoot);

    await expect(
      downloadDemoTraces({
        cacheRoot,
        fetcher: async () => new Response("auth required", { status: 401 }),
      }),
    ).rejects.toThrow("HTTP 401");
  });
});

describe("File import queue", () => {
  test("imports a JSONL file end to end", async () => {
    const path = writeJsonl([
      makeSpanRecord({
        attributes: {
          "agent.name": "Gator Flue Agent",
          "input.value": "List contacts",
          "openinference.span.kind": "AGENT",
          "output.value": "Here are contacts",
          "session.id": "session-1",
        },
        name: "agent.run",
        span_id: "aaaaaaaaaaaaaaaa",
      }),
      makeSpanRecord({
        attributes: {
          "llm.model_name": "claude-sonnet-4-6",
          "llm.provider": "anthropic",
          "llm.token_count.completion": 20,
          "llm.token_count.prompt": 10,
          "llm.token_count.total": 30,
          "openinference.span.kind": "LLM",
          "session.id": "session-1",
        },
        kind: "SPAN_KIND_CLIENT",
        name: "llm.chat",
        parent_span_id: "aaaaaaaaaaaaaaaa",
        span_id: "bbbbbbbbbbbbbbbb",
      }),
      "malformed line",
    ]);

    const database = createDatabase(":memory:");
    ensureSchema(database.sqlite);
    const live = createLiveEventStore(database.sqlite);
    const service = createFileImportService({ database, live });

    try {
      const job = await service.start({ filePath: path });
      const completed = await waitForImportJob(database.sqlite, job.id, "completed");

      expect(completed.importedTraces).toBe(1);
      expect(completed.importedObservations).toBe(2);
      expect(completed.totalTraces).toBe(1);
      expect(completed.totalObservations).toBe(2);
      expect(completed.skippedLines).toBe(1);
      expect(completed.failedTraces).toBe(0);
      expect(completed.fileName).toBe("traces.jsonl");

      const trace = getTrace(database.sqlite, TRACE_ID);
      expect(trace?.rootSpanName).toBe("agent.run");
      expect(trace?.serviceName).toBe("gator-agent");
      expect(trace?.agentName).toBe("Gator Flue Agent");
      expect(trace?.llmSpanCount).toBe(1);
      expect(trace?.totalTokens).toBe(30);
      expect(trace?.source).toBe("file");
      expect(trace?.sourceConnectionName).toBe("traces.jsonl");
      expect(trace?.sourceTraceId).toBe(TRACE_ID);
      expect(trace?.sessionId).toBe("session-1");

      const spans = getSpansForTrace(database.sqlite, { traceId: TRACE_ID });
      expect(spans.spans).toHaveLength(2);
      const llmSpan = spans.spans.find((span) => span.observationKind === "LLM");
      expect(llmSpan?.llmModelName).toBe("claude-sonnet-4-6");
      expect(llmSpan?.parentSpanId).toBe("aaaaaaaaaaaaaaaa");
    } finally {
      await service.close(true);
      database.sqlite.close(false);
    }
  });

  test("imports a gzipped JSONL file end to end", async () => {
    const path = writeGzippedJsonl([
      makeSpanRecord({
        attributes: {
          "agent.name": "Compressed Agent",
          "openinference.span.kind": "AGENT",
          "session.id": "session-1",
        },
        name: "agent.run",
        span_id: "aaaaaaaaaaaaaaaa",
      }),
      makeSpanRecord({
        attributes: {
          "llm.model_name": "gpt-5.2",
          "openinference.span.kind": "LLM",
          "session.id": "session-1",
        },
        name: "llm.chat",
        parent_span_id: "aaaaaaaaaaaaaaaa",
        span_id: "bbbbbbbbbbbbbbbb",
      }),
    ]);

    const database = createDatabase(":memory:");
    ensureSchema(database.sqlite);
    const live = createLiveEventStore(database.sqlite);
    const service = createFileImportService({ database, live });

    try {
      const job = await service.start({ filePath: path });
      const completed = await waitForImportJob(database.sqlite, job.id, "completed");

      expect(completed.fileName).toBe("traces.jsonl.gz");
      expect(completed.importedTraces).toBe(1);
      expect(completed.importedObservations).toBe(2);

      const trace = getTrace(database.sqlite, TRACE_ID);
      expect(trace?.agentName).toBe("Compressed Agent");
      expect(trace?.sourceConnectionName).toBe("traces.jsonl.gz");
      expect(getSpansForTrace(database.sqlite, { traceId: TRACE_ID }).spans).toHaveLength(
        2,
      );
    } finally {
      await service.close(true);
      database.sqlite.close(false);
    }
  });

  test("accepts uploads and imports the stored copy", async () => {
    const { createServerApp } = await import("../src/server/app");
    const database = createDatabase(":memory:");
    ensureSchema(database.sqlite);
    const live = createLiveEventStore(database.sqlite);
    const service = createFileImportService({ database, live });
    const app = createServerApp(database, live);

    try {
      const body = [
        JSON.stringify(makeSpanRecord({ name: "agent.run", span_id: "aaaaaaaaaaaaaaaa" })),
        JSON.stringify(
          makeSpanRecord({
            parent_span_id: "aaaaaaaaaaaaaaaa",
            span_id: "bbbbbbbbbbbbbbbb",
          }),
        ),
      ].join("\n");
      const response = await app.request("/v1/import/upload", {
        body,
        headers: { "x-halo-file-name": "../weird name!.jsonl" },
        method: "POST",
      });
      expect(response.status).toBe(200);
      const uploaded = (await response.json()) as {
        fileName: string;
        path: string;
        sizeBytes: number;
      };
      expect(uploaded.fileName).toBe("weird name_.jsonl");
      expect(uploaded.path.endsWith("/weird name_.jsonl")).toBe(true);
      expect(uploaded.sizeBytes).toBe(Buffer.byteLength(body));
      tempDirs.push(uploaded.path.replace(/\/[^/]+$/, ""));

      const job = await service.start({ filePath: uploaded.path });
      const completed = await waitForImportJob(database.sqlite, job.id, "completed");
      expect(completed.importedTraces).toBe(1);
      expect(completed.importedObservations).toBe(2);
      expect(completed.fileName).toContain("weird name_.jsonl");
    } finally {
      await service.close(true);
      database.sqlite.close(false);
    }
  });

  test("fails cleanly when the file is missing", async () => {
    const database = createDatabase(":memory:");
    ensureSchema(database.sqlite);
    const live = createLiveEventStore(database.sqlite);
    const service = createFileImportService({ database, live });
    try {
      expect(service.start({ filePath: "/nonexistent/traces.jsonl" })).rejects.toThrow(
        "File not found",
      );
    } finally {
      await service.close(true);
      database.sqlite.close(false);
    }
  });

  test("round-trips HALO's own JSONL export", async () => {
    // Ingest natively, export to JSONL, import into a fresh database, and the
    // canonical span data must survive the trip.
    const sourceDb = createDatabase(":memory:");
    ensureSchema(sourceDb.sqlite);
    const otlp = jsonlSpansToOtlp(
      [
        makeSpanRecord({
          attributes: {
            "agent.name": "Gator Flue Agent",
            "openinference.span.kind": "AGENT",
          },
          name: "agent.run",
          span_id: "aaaaaaaaaaaaaaaa",
        }),
        makeSpanRecord({
          attributes: {
            "llm.model_name": "claude-sonnet-4-6",
            "llm.token_count.total": 30,
            "openinference.span.kind": "LLM",
          },
          name: "llm.chat",
          parent_span_id: "aaaaaaaaaaaaaaaa",
          span_id: "bbbbbbbbbbbbbbbb",
        }),
      ],
      { fileName: "seed.jsonl" },
    );
    // Strip the file-provenance attributes the helper added — this seeds the
    // database as if the spans arrived from a live agent.
    for (const rs of otlp.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          span.attributes = span.attributes?.filter(
            (a) => !a.key.startsWith("halo.source"),
          );
        }
      }
    }
    const body = JSON.stringify(otlp);
    ingestTelemetry(sourceDb.sqlite, {
      body,
      contentEncoding: "identity",
      sizeBytes: Buffer.byteLength(body),
    });

    const exportDir = mkdtempSync(join(tmpdir(), "halo-fileexport-"));
    tempDirs.push(exportDir);
    const exported = exportHaloTraceJsonl(sourceDb.sqlite, {
      filters: {},
      outputDir: exportDir,
      runId: "round-trip-test",
      targetType: "trace_group",
    });
    sourceDb.sqlite.close(false);

    const destDb = createDatabase(":memory:");
    ensureSchema(destDb.sqlite);
    const live = createLiveEventStore(destDb.sqlite);
    const service = createFileImportService({ database: destDb, live });
    try {
      const job = await service.start({ filePath: exported.path });
      const completed = await waitForImportJob(destDb.sqlite, job.id, "completed");
      expect(completed.importedTraces).toBe(1);
      expect(completed.importedObservations).toBe(2);
      expect(completed.skippedLines).toBe(0);

      const traces = listTraces(destDb.sqlite, { cursor: null });
      expect(traces.traces).toHaveLength(1);
      const trace = getTrace(destDb.sqlite, TRACE_ID);
      expect(trace?.rootSpanName).toBe("agent.run");
      expect(trace?.serviceName).toBe("gator-agent");
      expect(trace?.agentName).toBe("Gator Flue Agent");
      expect(trace?.totalTokens).toBe(30);
      expect(trace?.source).toBe("file");
      const spans = getSpansForTrace(destDb.sqlite, { traceId: TRACE_ID });
      expect(spans.spans).toHaveLength(2);
      const llmSpan = spans.spans.find((span) => span.observationKind === "LLM");
      expect(llmSpan?.llmModelName).toBe("claude-sonnet-4-6");
      expect(llmSpan?.totalTokens).toBe(30);
    } finally {
      await service.close(true);
      destDb.sqlite.close(false);
    }
  });
});

async function waitForImportJob(
  sqlite: ReturnType<typeof createDatabase>["sqlite"],
  jobId: string,
  status: string,
) {
  const timeoutAt = Date.now() + 4_000;
  while (Date.now() < timeoutAt) {
    const job = getFileImportJob(sqlite, jobId);
    if (job?.status === status) return job;
    if (job?.status === "failed") {
      throw new Error(job.errorMessage ?? "Import failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for import job ${jobId}`);
}

function makeSpanRecord(overrides: Partial<JsonlSpanRecord> = {}): JsonlSpanRecord {
  return {
    attributes: { "openinference.span.kind": "TOOL", "tool.name": "contacts.list" },
    end_time: "2026-05-22T10:00:03.000Z",
    kind: "SPAN_KIND_INTERNAL",
    name: "tool.contacts.list",
    parent_span_id: "",
    resource: {
      attributes: {
        "service.name": "gator-agent",
        "service.version": "0.0.1",
      },
    },
    scope: { name: "@inference/tracing", version: "1.0.0" },
    span_id: "dddddddddddddddd",
    start_time: "2026-05-22T10:00:02.000Z",
    status: { code: "STATUS_CODE_OK", message: "" },
    trace_id: TRACE_ID,
    trace_state: "",
    ...overrides,
  };
}
