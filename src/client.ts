import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POLL_SECONDS = 15;

export interface ReviewEvent {
  type: "review.completed";
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  sequence: number;
  createdAt: string;
  summary: { comments: number; replies: number; suggestions: number; unresolved: number };
  overallComment?: string;
}

export interface ReviewResult {
  path: string;
  events: ReviewEvent[];
}

export interface ReviewOptions {
  path: string;
  cwd: string;
  signal: AbortSignal;
  openBrowser?: boolean;
  timeoutSeconds?: number;
  onReady?: (info: { path: string; url: string }) => void;
  /** Override the child environment, principally for isolated local installs. */
  env?: NodeJS.ProcessEnv;
}

interface WatchResult {
  events: ReviewEvent[];
  timedOut: boolean;
  nextSequence: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function localUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("Roughdraft did not return a URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password) {
    throw new Error("This extension supports only local, loopback Roughdraft servers.");
  }
  return url;
}

function parseSummary(value: unknown): ReviewEvent["summary"] {
  if (!record(value) || !integer(value.comments) || !integer(value.replies)
      || !integer(value.suggestions) || !integer(value.unresolved)) {
    throw new Error("Roughdraft returned an invalid review summary.");
  }
  return {
    comments: value.comments, replies: value.replies,
    suggestions: value.suggestions, unresolved: value.unresolved,
  };
}

function parseWatchResult(value: unknown, documentPath: string): WatchResult {
  if (!record(value) || !Array.isArray(value.events) || value.events.length > 100
      || typeof value.timedOut !== "boolean" || !integer(value.nextSequence, 1)) {
    throw new Error("Roughdraft returned an invalid review response.");
  }
  const { timedOut, nextSequence } = value;
  const events = value.events.map((event: unknown): ReviewEvent => {
    if (!record(event) || event.type !== "review.completed" || event.documentPath !== documentPath
        || typeof event.projectPath !== "string" || typeof event.relativePath !== "string"
        || typeof event.version !== "string" || typeof event.createdAt !== "string"
        || !integer(event.sequence, 1) || event.sequence >= nextSequence
        || (event.overallComment !== undefined && typeof event.overallComment !== "string")) {
      throw new Error("Roughdraft returned an invalid or mismatched review event.");
    }
    return {
      type: "review.completed", documentPath,
      projectPath: event.projectPath, relativePath: event.relativePath,
      version: event.version, createdAt: event.createdAt, sequence: event.sequence,
      summary: parseSummary(event.summary), overallComment: event.overallComment,
    };
  });
  if (timedOut && events.length !== 0) {
    throw new Error("Roughdraft returned events in a timed-out response.");
  }
  return { events, timedOut, nextSequence };
}

async function jsonRequest(url: URL, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout((POLL_SECONDS + 5) * 1000)]),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Roughdraft request failed (HTTP ${response.status}).`);
  return response.json();
}

async function serverPid(serverUrl: URL, signal: AbortSignal): Promise<number> {
  const status = await jsonRequest(new URL("/api/status", serverUrl), signal);
  if (!record(status) || status.backend !== "local-files" || !integer(status.pid, 1)) {
    throw new Error("The local server does not expose the expected Roughdraft API.");
  }
  return status.pid;
}

/** Opens an existing local Markdown file and waits for its next explicit review handoff. */
export async function reviewDocument(options: ReviewOptions): Promise<ReviewResult> {
  const env = options.env ?? process.env;
  if (env.ROUGHDRAFT_HOST?.trim()) {
    throw new Error("Remote Roughdraft sessions are not supported by this extension. Unset ROUGHDRAFT_HOST to use local review.");
  }
  if (options.timeoutSeconds !== undefined && (!Number.isFinite(options.timeoutSeconds)
      || options.timeoutSeconds < 1 || options.timeoutSeconds > 86_400)) {
    throw new Error("timeoutSeconds must be between 1 and 86400, or omitted to wait until canceled.");
  }
  options.signal.throwIfAborted();
  const documentPath = path.resolve(options.cwd, options.path);
  if (path.extname(documentPath).toLowerCase() !== ".md") {
    throw new Error(`Roughdraft needs a saved .md file: ${JSON.stringify(documentPath)}.`);
  }
  let documentStat;
  try {
    documentStat = await stat(documentPath);
  } catch (error) {
    if (record(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new Error(`Roughdraft could not find ${JSON.stringify(documentPath)}. Save the Markdown file first, then try again.`, { cause: error });
    }
    throw error;
  }
  if (!documentStat.isFile()) {
    throw new Error(`Roughdraft needs a saved .md file: ${JSON.stringify(documentPath)} is not a file.`);
  }

  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const timer = options.timeoutSeconds === undefined ? undefined : setTimeout(() => {
    lifetime.abort(new DOMException(`Review timed out after ${options.timeoutSeconds} seconds.`, "TimeoutError"));
  }, options.timeoutSeconds * 1000);
  timer?.unref();

  async function open(noOpen: boolean): Promise<Record<string, unknown>> {
    const binary = env.ROUGHDRAFT_BIN?.trim() || "roughdraft";
    const args = ["open", documentPath, "--no-watch", "--json"];
    if (noOpen) args.push("--no-open");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(binary, args, {
        cwd: options.cwd, env, signal, timeout: 20_000, maxBuffer: 1024 * 1024,
        windowsHide: true,
      }));
    } catch (error) {
      signal.throwIfAborted();
      if (record(error) && error.code === "ENOENT") {
        throw new Error(`Roughdraft CLI was not found at ${JSON.stringify(binary)}. Install the tested fork using https://github.com/pmbaumgartner/roughdraft#quick-start, then retry, or set ROUGHDRAFT_BIN to its executable path.`, { cause: error });
      }
      throw error;
    }
    const result: unknown = JSON.parse(stdout);
    if (!record(result) || result.opened !== true || result.path !== documentPath) {
      throw new Error("Roughdraft returned an unexpected open response.");
    }
    return result;
  }

  try {
    // Bootstrap quietly so the review cursor is established before a browser can submit.
    const opened = await open(true);
    const serverUrl = localUrl(opened.serverUrl);
    const viewerUrl = localUrl(opened.url);
    if (viewerUrl.origin !== serverUrl.origin) throw new Error("Roughdraft returned inconsistent local URLs.");
    const originalPid = await serverPid(serverUrl, signal);
    const target = { projectPath: path.dirname(documentPath), path: path.basename(documentPath) };
    const watchUrl = new URL("/api/review-events/watch", serverUrl);
    const baseline = parseWatchResult(await jsonRequest(watchUrl, signal, {
      ...target, fromNow: true, timeoutSeconds: 0, batchWindowSeconds: 0,
    }), documentPath);

    async function waitForReview(): Promise<ReviewResult> {
      let cursor = baseline.nextSequence - 1;
      while (true) {
        signal.throwIfAborted();
        const result = parseWatchResult(await jsonRequest(watchUrl, signal, {
          ...target, fromNow: false, afterSequence: cursor,
          timeoutSeconds: POLL_SECONDS, batchWindowSeconds: 0,
        }), documentPath);
        if (result.nextSequence <= cursor || await serverPid(serverUrl, signal) !== originalPid) {
          throw new Error("Roughdraft restarted while waiting. Open a new review to reestablish the handoff.");
        }
        if (result.events.some((event) => event.sequence <= cursor)) {
          throw new Error("Roughdraft returned an event from an earlier review.");
        }
        if (result.events.length) return { path: documentPath, events: result.events };
        if (!result.timedOut) throw new Error("Roughdraft ended the watch without a review event.");
        cursor = result.nextSequence - 1;
      }
    }

    options.onReady?.({ path: documentPath, url: viewerUrl.href });
    // Either operation may fail; the shared lifetime cancels its sibling in finally.
    const [result] = await Promise.all([
      waitForReview(),
      options.openBrowser !== false ? open(false) : undefined,
    ]);
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    lifetime.abort(new DOMException("Review ended.", "AbortError"));
  }
}
