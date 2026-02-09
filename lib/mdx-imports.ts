import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const FRONTMATTER_RE = /^---[\s\S]*?\n---\n?/;
const IMPORT_LINE_RE =
  /^\s*import\s+.+?\s+from\s+["']([^"']+\.mdx?)["'];?\s*$/gm;
const IMPORT_EXPORT_LINE_RE = /^\s*(import|export)\s.+$/gm;

interface ResolvedImport {
  path: string;
  content: string;
}

const fileContentCache = new Map<string, Promise<string>>();
const resolvedImportCache = new Map<string, Promise<ResolvedImport | null>>();
const importedMdxTextCache = new Map<string, Promise<string>>();

function readFileCached(filePath: string): Promise<string> {
  const cached = fileContentCache.get(filePath);
  if (cached) return cached;

  const pending = readFile(filePath, "utf8");
  fileContentCache.set(filePath, pending);
  return pending;
}

export function cleanMdxForIndexing(content: string): string {
  return content
    .replace(FRONTMATTER_RE, "")
    .replace(IMPORT_EXPORT_LINE_RE, "")
    .trim();
}

async function resolveLocalMdxImport(
  baseDir: string,
  specifier: string,
): Promise<ResolvedImport | null> {
  if (!specifier.startsWith(".")) return null;
  const cacheKey = `${baseDir}\0${specifier}`;
  const cached = resolvedImportCache.get(cacheKey);
  if (cached) return cached;

  const pending = (async (): Promise<ResolvedImport | null> => {
    const directPath = resolve(baseDir, specifier);
    const candidates = directPath.endsWith(".mdx")
      ? [directPath]
      : [directPath, `${directPath}.mdx`];

    for (const candidate of candidates) {
      try {
        const content = await readFileCached(candidate);
        return { path: candidate, content };
      } catch {
        // continue
      }
    }

    return null;
  })();

  resolvedImportCache.set(cacheKey, pending);
  return pending;
}

async function collectImportedMdxText(
  rawMdx: string,
  baseDir: string,
  visited: Set<string>,
): Promise<string> {
  IMPORT_LINE_RE.lastIndex = 0;
  const matches = Array.from(rawMdx.matchAll(IMPORT_LINE_RE));
  if (matches.length === 0) return "";

  const chunks: string[] = [];
  for (const match of matches) {
    const specifier = match[1];
    const imported = await resolveLocalMdxImport(baseDir, specifier);
    if (!imported || visited.has(imported.path)) continue;

    visited.add(imported.path);
    chunks.push(cleanMdxForIndexing(imported.content));

    const nested = await collectImportedMdxText(
      imported.content,
      dirname(imported.path),
      visited,
    );
    if (nested) chunks.push(nested);
  }

  return chunks.join("\n");
}

async function resolvePageAbsolutePath(pagePath: string): Promise<string | null> {
  const directPath = resolve(process.cwd(), "content/docs", pagePath);
  const candidates = directPath.endsWith(".mdx")
    ? [directPath]
    : [directPath, `${directPath}.mdx`];

  for (const candidate of candidates) {
    try {
      await readFileCached(candidate);
      return candidate;
    } catch {
      // continue
    }
  }

  return null;
}

export async function getImportedMdxTextForPage(pagePath: string): Promise<string> {
  const absolutePath = await resolvePageAbsolutePath(pagePath);
  if (!absolutePath) return "";

  const cached = importedMdxTextCache.get(absolutePath);
  if (cached) return cached;

  const pending = (async (): Promise<string> => {
    const rawPage = await readFileCached(absolutePath);
    return collectImportedMdxText(
      rawPage,
      dirname(absolutePath),
      new Set<string>([absolutePath]),
    );
  })();

  importedMdxTextCache.set(absolutePath, pending);
  return pending;
}
