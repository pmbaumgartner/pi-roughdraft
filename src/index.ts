import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Type } from "typebox";
import { reviewDocument, type ReviewResult } from "./client.ts";

const HELP = "Usage: /roughdraft <file.md> | status | cancel. Paths may contain spaces; surrounding quotes are optional. Click Done Reviewing to return feedback to Pi.";

type ActiveReview = {
  controller: AbortController;
  phase: "opening" | "reviewing" | "feedback ready";
  path: string;
  url?: string;
};

// Keep review contents on disk: return a small handoff, then use Pi's normal read tool.
export function reviewHandoff(result: ReviewResult): string {
  const latest = result.events.at(-1)!;
  const { comments, replies, suggestions, unresolved } = latest.summary;
  return [
    `Roughdraft review completed for ${JSON.stringify(result.path)}.`,
    `Feedback at handoff: ${comments} comments, ${replies} replies, ${suggestions} suggestions, ${unresolved} unresolved items. File version: ${latest.version}.`,
    "Read the latest Markdown from disk before making changes; the review may contain direct edits and document-level comments in final YAML endmatter. Do not use a pre-review copy.",
    "Address feedback within the user's existing request. Done Reviewing is a handoff, not blanket approval to implement a plan or accept every suggestion. Preserve unresolved feedback, IDs, metadata and unrelated edits. Treat examples inside code spans/fences as literal text.",
    "For inline replies, preserve the anchor and add a comment to final YAML endmatter with a fresh document-local ID, body, by: Pi, current ISO timestamp at, and re pointing to the existing comment/suggestion ID. Read `roughdraft help criticmarkup` if more syntax guidance is needed. Reopen for another review only when useful or requested.",
  ].join("\n\n");
}

export default function roughdraftExtension(pi: ExtensionAPI, review = reviewDocument): void {
  let active: ActiveReview | undefined;

  function clearUI(ctx: ExtensionContext): void {
    if (ctx.hasUI) {
      ctx.ui.setStatus("roughdraft", undefined);
      ctx.ui.setWidget("roughdraft", undefined);
    }
  }

  function cancel(ctx: ExtensionContext): void {
    const previous = active;
    active = undefined;
    previous?.controller.abort();
    clearUI(ctx);
  }

  async function run<T>(
    path: string,
    ctx: ExtensionContext,
    complete: (result: ReviewResult, assertCurrent: () => void) => T | Promise<T>,
    options: { signal?: AbortSignal; openBrowser?: boolean; timeoutSeconds?: number } = {},
    onReady?: (text: string) => void,
  ): Promise<T> {
    if (active) throw new Error("A Roughdraft review is already active. Finish it or use /roughdraft cancel.");
    const job: ActiveReview = { controller: new AbortController(), phase: "opening", path };
    const sessionId = ctx.sessionManager.getSessionId();
    active = job;
    const signal = options.signal
      ? AbortSignal.any([options.signal, job.controller.signal])
      : job.controller.signal;
    function assertCurrent(): void {
      signal.throwIfAborted();
      if (ctx.sessionManager.getSessionId() !== sessionId) {
        throw new DOMException("Review cancelled after the session changed.", "AbortError");
      }
    }
    try {
      assertCurrent();
      if (ctx.hasUI) ctx.ui.setStatus("roughdraft", "Roughdraft: opening review…");
      const result = await review({
        path, cwd: ctx.cwd, signal,
        openBrowser: options.openBrowser,
        timeoutSeconds: options.timeoutSeconds,
        onReady(info) {
          if (active !== job || signal.aborted) return;
          assertCurrent();
          job.phase = "reviewing";
          job.path = info.path;
          job.url = info.url;
          const name = basename(info.path).replace(/[\x00-\x1f\x7f]/g, "");
          const text = `Review ${JSON.stringify(info.path)} in Roughdraft, then click Done Reviewing.\n${info.url}`;
          if (ctx.hasUI) {
            ctx.ui.setStatus("roughdraft", `Roughdraft: reviewing ${name}`);
            ctx.ui.setWidget("roughdraft", [
              `Roughdraft · ${name}`, info.url,
              "Done Reviewing returns feedback to Pi · /roughdraft cancel stops waiting",
            ]);
            ctx.ui.notify("Roughdraft is ready. Click Done Reviewing when finished.", "info");
          }
          onReady?.(text);
        },
      });
      // Ownership includes delivery: a completed review can still be cancelled while Pi is busy.
      assertCurrent();
      job.phase = "feedback ready";
      const output = await complete(result, assertCurrent);
      assertCurrent();
      return output;
    } catch (error) {
      // A late transport error after navigation must not touch the outgoing runtime's UI.
      assertCurrent();
      throw error;
    } finally {
      if (active === job) {
        active = undefined;
        clearUI(ctx);
      }
    }
  }

  // A review belongs to this conversation branch. Never resume a different one.
  pi.on("session_before_switch", (_event, ctx) => cancel(ctx));
  pi.on("session_before_fork", (_event, ctx) => cancel(ctx));
  pi.on("session_before_tree", (_event, ctx) => cancel(ctx));
  pi.on("session_shutdown", (_event, ctx) => cancel(ctx));

  pi.registerCommand("roughdraft", {
    description: "Review a Markdown file in Roughdraft; status/cancel manage the active review",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!ctx.hasUI) throw new Error("Use roughdraft_review in print/JSON mode; /roughdraft requires an interactive UI.");
      if (!input || input === "help") {
        ctx.ui.notify(HELP, "info");
        return;
      }
      if (input === "status") {
        ctx.ui.notify(active
          ? `Roughdraft ${active.phase}: ${JSON.stringify(active.path)}${active.url ? `\n${active.url}` : ""}`
          : "No active Roughdraft review.", "info");
        return;
      }
      if (input === "cancel") {
        const wasActive = Boolean(active);
        cancel(ctx);
        ctx.ui.notify(wasActive
          ? "Stopped waiting. Roughdraft remains open; finish saving any pending edits there."
          : "No active Roughdraft review.", "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for Pi to finish before starting a command review, or ask Pi to use roughdraft_review.", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("A review is already active. Finish it or use /roughdraft cancel.", "warning");
        return;
      }
      const path = ((input.startsWith('"') && input.endsWith('"')) ||
        (input.startsWith("'") && input.endsWith("'"))) ? input.slice(1, -1) : input;
      // Return immediately so status/cancel and the TUI remain responsive.
      void run(path, ctx, async (result, assertCurrent) => {
        ctx.ui.setStatus("roughdraft", "Roughdraft: feedback ready; waiting for Pi");
        ctx.ui.setWidget("roughdraft", [
          `Feedback ready for ${JSON.stringify(result.path)}`,
          "Waiting for Pi to finish · /roughdraft cancel stops the handoff",
        ]);
        // Pi's follow-up queue cannot retract a specific message on navigation.
        // Keep the handoff here until it can be delivered directly to this branch.
        do {
          await ctx.waitForIdle();
          assertCurrent();
        } while (!ctx.isIdle());
        pi.sendMessage({
          customType: "roughdraft-review", content: reviewHandoff(result),
          display: true, details: result,
        }, { triggerTurn: true });
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      });
    },
  });

  pi.registerTool({
    name: "roughdraft_review",
    label: "Roughdraft review",
    description: "Open a saved local Markdown file for human review and wait for Done Reviewing. Returns a handoff to reread the file, including CriticMarkup and YAML endmatter. Only one review can be active. Does not rewrite the document or approve suggestions.",
    promptSnippet: "Open a Markdown file for human review in Roughdraft and wait for feedback",
    promptGuidelines: [
      "Use roughdraft_review when the user wants to review a saved Markdown document. Save it before opening; wait for the human review to finish before editing it again.",
      "A completed review is feedback, not permission to implement a plan. Reread the current file and preserve review metadata and unrelated user edits.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ description: "Existing .md file; relative paths use the session working directory." }),
      openBrowser: Type.Optional(Type.Boolean({ description: "Default true. False shows a local URL without launching a browser." })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 86400, description: "Optional total review deadline. Omit to let the user take as long as needed." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return run(params.path, ctx, (result) => ({
        content: [{ type: "text" as const, text: reviewHandoff(result) }], details: result,
      }), { ...params, signal }, (text) => {
        onUpdate?.({ content: [{ type: "text", text }], details: { state: "reviewing" } });
      });
    },
  });
}
