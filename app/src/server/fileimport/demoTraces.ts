import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const DEMO_TRACES_DATASET = {
  datasetUrl: "https://huggingface.co/datasets/inference-net/SearchAgentDemoTraces",
  fileCandidates: ["halo_search_agent_1000_traces.jsonl"],
  // Keep this allowlisted and deterministic: this is the public dataset's
  // main revision containing halo_search_agent_1000_traces.jsonl.
  revision: "6dd8e0422939749a5e839a6e1bda4291e4ca5e56",
  repoId: "inference-net/SearchAgentDemoTraces",
} as const;

export type DemoTracesDownloadResult = {
  cached: boolean;
  downloadedBytes: number;
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  revision: string;
  sourceUrl: string;
  totalBytes: number | null;
};

export type DemoTracesDownloadProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DemoTracesDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoTracesDownloadError";
  }
}

export function demoTracesCacheRoot(databasePath: string) {
  if (databasePath === ":memory:") return join(tmpdir(), "halo-demo-traces-cache");
  return join(dirname(databasePath), "cache", "demo-traces");
}

export function huggingFaceDemoTracesUrl(
  fileName: string,
  revision = DEMO_TRACES_DATASET.revision,
) {
  const repoPath = DEMO_TRACES_DATASET.repoId
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const filePath = fileName.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/datasets/${repoPath}/resolve/${encodeURIComponent(revision)}/${filePath}`;
}

export async function downloadDemoTraces(input: {
  cacheRoot: string;
  fetcher?: FetchLike;
  onProgress?: (progress: DemoTracesDownloadProgress) => void;
}): Promise<DemoTracesDownloadResult> {
  const fetcher = input.fetcher ?? fetch;

  await mkdir(input.cacheRoot, { recursive: true });

  for (const fileName of DEMO_TRACES_DATASET.fileCandidates) {
    const sourceUrl = huggingFaceDemoTracesUrl(fileName);
    const filePath = demoTracesCachePath(input.cacheRoot, fileName);
    const cached = await cachedFile(filePath);
    if (cached) {
      return {
        cached: true,
        downloadedBytes: 0,
        fileName: basename(filePath),
        filePath,
        fileSizeBytes: cached.size,
        revision: DEMO_TRACES_DATASET.revision,
        sourceUrl,
        totalBytes: cached.size,
      };
    }
  }

  const failures: string[] = [];
  for (const fileName of DEMO_TRACES_DATASET.fileCandidates) {
    const sourceUrl = huggingFaceDemoTracesUrl(fileName);
    const filePath = demoTracesCachePath(input.cacheRoot, fileName);
    try {
      const response = await fetcher(sourceUrl, {
        headers: { "user-agent": "HALO demo traces import" },
      });
      if (!response.ok) {
        failures.push(`${fileName}: HTTP ${response.status}`);
        continue;
      }
      const totalBytes = parseContentLength(response.headers.get("content-length"));
      const downloadedBytes = await writeResponseBody({
        filePath,
        onProgress: input.onProgress,
        response,
        totalBytes,
      });
      if (downloadedBytes <= 0) {
        await unlink(filePath).catch(() => undefined);
        failures.push(`${fileName}: empty response body`);
        continue;
      }
      return {
        cached: false,
        downloadedBytes,
        fileName: basename(filePath),
        filePath,
        fileSizeBytes: downloadedBytes,
        revision: DEMO_TRACES_DATASET.revision,
        sourceUrl,
        totalBytes,
      };
    } catch (error) {
      failures.push(
        `${fileName}: ${error instanceof Error ? error.message : "download failed"}`,
      );
    }
  }

  throw new DemoTracesDownloadError(
    [
      "Could not download demo traces from the public Hugging Face dataset.",
      "HALO only imports the allowlisted SearchAgentDemoTraces JSONL files.",
      failures.length > 0 ? `Attempts: ${failures.join("; ")}.` : null,
      "Check your network connection or confirm the dataset is public.",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function demoTracesCachePath(cacheRoot: string, fileName: string) {
  const safeRevision = safePathSegment(DEMO_TRACES_DATASET.revision);
  const safeName = fileName
    .split("/")
    .map(safePathSegment)
    .join("__");
  return join(cacheRoot, `${safeRevision}-${safeName}`);
}

async function cachedFile(filePath: string) {
  try {
    const file = await stat(filePath);
    return file.isFile() && file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

async function writeResponseBody(input: {
  filePath: string;
  onProgress?: (progress: DemoTracesDownloadProgress) => void;
  response: Response;
  totalBytes: number | null;
}) {
  if (!input.response.body) {
    throw new Error("response did not include a readable body");
  }

  const tmpPath = `${input.filePath}.${crypto.randomUUID()}.tmp`;
  const writer = Bun.file(tmpPath).writer();
  let downloadedBytes = 0;
  try {
    const reader = input.response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      writer.write(value);
      downloadedBytes += value.byteLength;
      input.onProgress?.({
        downloadedBytes,
        totalBytes: input.totalBytes,
      });
    }
    await writer.end();
    await rename(tmpPath, input.filePath);
    return downloadedBytes;
  } catch (error) {
    writer.end();
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function parseContentLength(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
