# Hand-over

`vite build` copies `public/` verbatim, so stage temps outside that directory and rename them into place:

node scripts/write-atomic.mjs /workspace/.grok/og.jpg.tmp public/og.jpg

node scripts/write-atomic.mjs /workspace/.grok/x-banner.jpg.tmp public/x-banner.jpg

node scripts/write-atomic.mjs /workspace/.grok/site.json.tmp src/lib/og/site.json
