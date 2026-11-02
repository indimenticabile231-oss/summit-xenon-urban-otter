# OG share card

落片 ships a custom share card (`public/og.jpg`) and `src/lib/og/site.json` with `"title": "落片"`.

While a brand-asset pass is generating, it holds the marker at `/workspace/.grok/og-pending`. The parent's gate treats that marker as in-flight silence. A marker older than 10 minutes is stale: a Stop mid-generation must not hide a missing card forever.

## Brand-asset pass:

Judge the files on disk with this script. Do not wait_tasks and do not get_task_output for this pass. The parent never waits on the brand task, and a gate that waits would redo work the pass is still writing.

```
node scripts/brand-check.mjs
node scripts/brand-check.mjs --game
node scripts/brand-check.mjs --placeholder-ok
```

`--game` is for a canvas or DOM game (custom card, `"type": "x:game"`, and `public/x-banner.jpg`). `--placeholder-ok` is only for a plain utility that keeps the og.grok.me placeholder. Hand `public/og.jpg`, `public/x-banner.jpg`, and `src/lib/og/site.json` over with `write-atomic` as written in `references/handover.md`. Stage temps under `/workspace/.grok/`, not under `public/`.

## After the pass

Remove `/workspace/.grok/og-pending` when the files are in place.
