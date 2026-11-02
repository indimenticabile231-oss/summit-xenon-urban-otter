# Agent notes

落片 saves a Bilibili detail page as a video file. The share-card title lives in `src/lib/og/site.json` and is 落片.

The brand task's in-flight marker is `/workspace/.grok/og-pending`. A marker older than 10 minutes is stale and must not keep hiding a missing card.

6. **Brand-asset pass.** Never wait_tasks and never get_task_output for this step. The parent does not wait on the brand task; the pass checks its own files with `node scripts/brand-check.mjs` and hands assets over with `node scripts/write-atomic.mjs`.

7. **Verify.** Run typecheck, test, and lint after the pass, without waiting on that task.
