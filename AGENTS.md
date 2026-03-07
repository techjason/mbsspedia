# AGENTS.md

## Cursor Cloud specific instructions

This is a Next.js + Fumadocs MDX medical knowledge base (MBBSPedia). It is a single-app repo (not a monorepo).

### Quick reference

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Dev server | `npm run dev` (serves on port 3000) |
| Lint | `npm run lint` (ESLint) |
| Build | `npm run build` |

### Notes

- The dev server (Next.js Turbopack) takes ~15-20 seconds for first page compile after start. Wait before curling or browsing.
- There is a pre-existing lint error in `components/accordion.tsx` (`react-hooks/set-state-in-effect`). This is not a regression — do not attempt to fix it unless explicitly asked.
- AI features (chat, search, active-recall grading) require external API keys (`MIXEDBREAD_API_KEY`, `MIXEDBREAD_STORE_IDENTIFIER`, and Vercel AI Gateway config). Without them the core documentation browsing still works — only the `/api/chat`, `/api/search`, and `/api/active-recall/grade` endpoints will error.
- No Docker, no database, and no background workers are needed. The app is fully stateless.
- Content lives in `content/docs/` (topic pages) and `content/fragments/` (reusable sections). Changes to MDX files are picked up by the dev server's hot reload.
