# MBBSPedia

MBBSPedia is a Next.js + Fumadocs medical knowledge base for MBBS revision.

## Purpose

- Provide structured, searchable revision notes.
- Keep claims traceable through visible citations.
- Publish only content derived from permitted public sources.

## Source and Compliance Policy

This repository is intended for a public website. Public content must follow these rules:

- Allowed: public guidelines, public-domain material, and content with explicit reuse permission.
- Prohibited in public content: lecture slides from restricted LMS platforms, private teaching handouts, and private senior notes.
- AI outputs are draft assistance only and must be verified against permitted sources before publication.
- References must be visible on published pages.

If a page includes restricted-derived content, mark it as `restricted-derived` and rewrite from permitted sources before keeping it public.

## Medical Disclaimer

This project is for education only. It is not medical advice, not a diagnostic tool, and not a substitute for clinical supervision, local protocols, or specialist care.

## Project Structure

- `app/`: Next.js App Router pages and API routes.
- `content/docs/`: Topic entry pages.
- `content/fragments/`: Reusable section content rendered inside topic tabs.
- `components/mdx/`: Custom MDX components, including citations.
- `lib/mdx/remark-citations.ts`: Citation and references transform plugin.
- `scripts/`: Content-generation and retrieval tooling.

## Development

### Prerequisites

- Node.js 20+
- npm

### Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Build

```bash
npm run build
npm run start
```

### Orama Cloud Search

Search is configured to use Orama Cloud when the following environment
variables are available:

- `NEXT_PUBLIC_ORAMA_ENDPOINT` (or `NEXT_PUBLIC_ORAMA_API_ENDPOINT`)
- `NEXT_PUBLIC_ORAMA_API_KEY`

Indexing/import is managed from the Orama Cloud dashboard (website importer).

### Lint

```bash
npm run lint
```

## Content Editing Workflow

1. Edit topic files under `content/docs/` and fragments under `content/fragments/`.
2. Keep inline citation markers in content and maintain the references section.
3. Verify each cited source is publicly permissible for redistribution.
4. Update or remove material that cannot be attributed to permitted sources.

## Citation System

The project uses a custom MDX citation pipeline:

- Inline markers like `[1]` are converted to `<Cite n="1" />`.
- `## References` lists are converted to rendered `<References />` blocks.
- References are intentionally visible for auditability and trust.

Key files:

- `lib/mdx/remark-citations.ts`
- `components/mdx/citations.tsx`
- `mdx-components.tsx`

## Corrections and Takedown

If you identify potential copyright issues, inaccurate content, or outdated recommendations, open a repository issue with:

- Page path or URL
- Exact text to review
- Supporting context or source

Maintainers should prioritize removal or correction when rights or safety concerns are raised.
