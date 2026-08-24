<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- repo-task-sync:start -->
## Shared AI development context

Before changing code, read `.ai-team/PROJECT.md`, `.ai-team/TASK.md`, and `.ai-team/SKILL.md`. Summarize the goal, acceptance scenarios, invariants, completed work, pending work, decisions, and next step before implementation.

Keep one writer for the active task. Put code changes and `.ai-team/TASK.md` progress updates in the same pull request. Treat the merged Git commit as the only handoff snapshot; chat history and AI memory are not project facts. If `.ai-team/session-policy.json` explicitly enables private sessions, treat `.ai-team/sessions/` as low-priority trace evidence only and never let it override PROJECT, TASK, code, tests, or the current request.

Run the checks listed in `.ai-team/TASK.md` plus `node .ai-team/check.mjs --base <main-base>`. When private sessions are enabled, also run `node .ai-team/session.mjs validate` and review generated session Markdown before commit. Report actual evidence and any specification deviation.
<!-- repo-task-sync:end -->
