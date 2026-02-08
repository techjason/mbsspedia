import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";
import { structure, type StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

interface SearchIndexInput {
  locale?: string;
  url: string;
  path: string;
  absolutePath?: string;
  data: {
    title?: string;
    description?: string;
    structuredData?: StructuredData;
    load?: () => Promise<{ structuredData?: StructuredData }>;
  };
}

const FRONTMATTER_RE = /^---[\s\S]*?\n---\n?/;
const IMPORT_LINE_RE =
  /^\s*import\s+.+?\s+from\s+["']([^"']+\.mdx?)["'];?\s*$/gm;
const IMPORT_EXPORT_LINE_RE = /^\s*(import|export)\s.+$/gm;
const DEFAULT_LOCALE_KEY = "__default__";

interface ResolvedImport {
  path: string;
  content: string;
}

interface TreeNodeLike {
  type?: string;
  name?: unknown;
  url?: string;
  children?: TreeNodeLike[];
}

const fileContentCache = new Map<string, Promise<string>>();
const resolvedImportCache = new Map<string, Promise<ResolvedImport | null>>();
const importedStructuredDataCache = new Map<string, Promise<StructuredData | null>>();
const breadcrumbsByLocale = new Map<string, Map<string, string[]>>();

function isBreadcrumbLabel(name: unknown): name is string {
  return typeof name === "string" && name.length > 0;
}

function localeKey(locale?: string): string {
  return locale ?? DEFAULT_LOCALE_KEY;
}

function readFileCached(filePath: string): Promise<string> {
  const cached = fileContentCache.get(filePath);
  if (cached) return cached;

  const pending = readFile(filePath, "utf8");
  fileContentCache.set(filePath, pending);
  return pending;
}

function cleanMdxForIndexing(content: string): string {
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
        // Try the next path candidate.
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

async function getStructuredData(page: SearchIndexInput): Promise<StructuredData> {
  if (page.data.structuredData) return page.data.structuredData;
  if (typeof page.data.load === "function") {
    const loaded = await page.data.load();
    if (loaded.structuredData) return loaded.structuredData;
  }

  return { headings: [], contents: [] };
}

async function getImportedStructuredData(
  page: SearchIndexInput,
): Promise<StructuredData | null> {
  if (!page.absolutePath) return null;
  const filePath = page.absolutePath;
  const cached = importedStructuredDataCache.get(filePath);
  if (cached) return cached;

  const pending = (async (): Promise<StructuredData | null> => {
    const rawPage = await readFileCached(filePath);
    const baseDir = dirname(filePath);
    const visited = new Set<string>([filePath]);
    const importedText = await collectImportedMdxText(rawPage, baseDir, visited);
    if (!importedText) return null;
    return structure(importedText);
  })();

  importedStructuredDataCache.set(filePath, pending);
  return pending;
}

function buildBreadcrumbMap(locale?: string): Map<string, string[]> {
  const key = localeKey(locale);
  const cached = breadcrumbsByLocale.get(key);
  if (cached) return cached;

  const pageTree = source.getPageTree(locale) as TreeNodeLike;
  const map = new Map<string, string[]>();
  const root = isBreadcrumbLabel(pageTree.name) ? [pageTree.name] : [];

  function walk(nodes: TreeNodeLike[] | undefined, breadcrumbs: string[]) {
    if (!nodes) return;

    for (const node of nodes) {
      const isPage = node.type === "page" && typeof node.url === "string";
      if (isPage && node.url) map.set(node.url, breadcrumbs);

      const next =
        !isPage && isBreadcrumbLabel(node.name)
          ? [...breadcrumbs, node.name]
          : breadcrumbs;

      walk(node.children, next);
    }
  }

  walk(pageTree.children, root);
  breadcrumbsByLocale.set(key, map);
  return map;
}

async function buildIndex(page: SearchIndexInput) {
  const structuredData = await getStructuredData(page);
  const importedStructuredData = await getImportedStructuredData(page);
  const breadcrumbs = buildBreadcrumbMap(page.locale).get(page.url);

  return {
    title: page.data.title ?? page.path.replace(/\.mdx?$/, ""),
    breadcrumbs,
    description: page.data.description,
    url: page.url,
    id: page.url,
    structuredData: importedStructuredData
      ? {
          headings: [
            ...structuredData.headings,
            ...importedStructuredData.headings,
          ],
          contents: [
            ...structuredData.contents,
            ...importedStructuredData.contents,
          ],
        }
      : structuredData,
  };
}

export const { GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: "english",
  buildIndex,
  search: {
    limit: 60,
    groupBy: {
      properties: ["page_id"],
      maxResult: 3,
    },
  },
});
