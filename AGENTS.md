# AGENTS.md — Codex Instructions

## On Every Task

1. Call `mcp__openclaw__get_tasks` with `assignee="codex"` and `status="pending"`
2. If no pending tasks, say "No codex tasks in queue" and stop
3. For each pending task (highest priority first):
   - Call `mcp__openclaw__claim_task` with the `task_id` and `agent="codex"`
   - Do the work
   - When done, call `mcp__openclaw__complete_task` with the `task_id` and a short `result` summary
   - If you can't complete it, call `mcp__openclaw__fail_task` with a `reason`

## Rules

- **Only work on tasks assigned to "codex"** — ignore everything else
- Never reassign or modify tasks assigned to other agents
- Commit and push your code changes as normal
- Write clean, production-quality code
- If a task references files, use `mcp__openclaw__read_file` to check context

## Context

- This is for **Continuum** — a longevity platform by Angela Busheska
- Repos: `Angelaangie-ai/continuum` (iOS), `Angelaangie-ai/chief` (dashboard), `Angelaangie-ai/molt-book` (web app)
- Design: black background, thin white borders, serif headers (Cormorant Garamond), sans-serif body (Inter/Raleway)
- Stack: SwiftUI (iOS), vanilla JS + Tailwind (web)
