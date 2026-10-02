---
name: roughdraft
description: Set up Roughdraft and its Pi integration, open saved Markdown for human review, and respond to CriticMarkup feedback. Use when installing this workflow, preparing a development environment, or when the user asks to review or comment on a Markdown document in Roughdraft or rd.
---

# Roughdraft

For installation and development setup, read [environment setup](references/environment-setup.md). If this skill is not already discoverable, install it in the agent's supported skill directory. Pi's extension package already supplies it; do not install a second copy there. Do not append it to AGENTS.md, CLAUDE.md, GEMINI.md, or another global instruction file. Do not create an `rd` executable or alias.

## Review a document

1. Save the current document as one local `.md` file. Preserve unrelated user edits.
2. In Pi, prefer `roughdraft_review` with the saved file's path. The user can also start `/roughdraft <file.md>` and use `status`, `cancel`, or `reopen`. The tool waits for Finish review and returns feedback to the owning conversation branch.
3. In another agent, run `roughdraft open "/absolute/path/to/file.md"`. In a source checkout, use its `roughdraft-dev-<worktree-name>` wrapper, or the explicitly configured `ROUGHDRAFT_BIN`. Leave the waiting command running until Finish review. Use `--no-watch` only when intentionally opening without a handoff.
4. After completion, reread the current Markdown from disk. Do not edit a pre-review snapshot. Overall comments live in final YAML endmatter; inline review uses CriticMarkup.
5. Answer questions and address feedback within the user's existing authorization. Finish review alone does not approve implementing a plan or accepting every suggestion. Preserve unresolved items, IDs, metadata, links, images, frontmatter, and literal code examples. Reopen when useful or requested.

Pi's scoped handoff distinguishes waiting, queued, received, and cancelled. Received means the owning Pi job accepted the feedback; it does not mean a model finished processing it. Cancellation leaves saved Markdown intact. Old servers and generic CLI watchers cannot confirm receipt; use the browser's copy-message fallback if needed.

## Read and write feedback

Base markers: comment `{>>text<<}`, insertion `{++text++}`, deletion `{--text--}`, substitution `{~~old~>new~~}`, highlight `{==text==}`. Ignore markers inside code spans and fenced code.

Prefer compact references with final YAML endmatter. Read the latest IDs before allocating a fresh document-local ID. Preserve older inline attribute blocks when present. For replies, keep the existing anchor and add `body`, `by`, the current ISO timestamp `at`, and `re` pointing to the parent comment or suggestion. Document-level comments have no inline anchor and no `re`.

```markdown
{==selected text==}{>>Clarify this.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-10-02T12:00:00.000Z"
  c2:
    body: Added the requested example.
    by: Pi
    at: "2026-10-02T12:05:00.000Z"
    re: c1
```

Run `roughdraft help criticmarkup` for exact syntax. Keep review data in the Markdown file.
