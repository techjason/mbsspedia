import { source } from "@/lib/source";
import {
  firstString,
  humanizeFilename,
  normalizeFsPath,
  stripDocExt,
} from "@/lib/mixedbread/chunk-utils";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOCAL_MDX_IMPORT_RE =
  /^\s*import\s+.+?\s+from\s+["']([^"']+\.(?:md|mdx))["'];?\s*$/gm;

interface PageInfo {
  path: string;
  stem: string;
  url: string;
  title: string;
}

const pageInfos: PageInfo[] = source.getPages().map((page) => {
  const normalizedPath = normalizeFsPath(page.path);
  return {
    path: normalizedPath,
    stem: docStemFromPagePath(normalizedPath),
    url: page.url,
    title: page.data.title ?? humanizeFilename(normalizedPath),
  };
});

const docsStemToUrl = new Map<string, string>();
const docsBasenameToPages = new Map<string, PageInfo[]>();
const pageTitleByUrl = new Map<string, string>();

for (const page of pageInfos) {
  docsStemToUrl.set(page.stem, page.url);
  pageTitleByUrl.set(page.url, page.title);

  const basename = page.stem.split("/").pop() ?? "";
  if (!basename) continue;

  const list = docsBasenameToPages.get(basename) ?? [];
  list.push(page);
  docsBasenameToPages.set(basename, list);
}

let fragmentToPageUrlMapPromise: Promise<Map<string, string>> | null = null;

function docStemFromPagePath(pagePath: string): string {
  let stem = stripDocExt(normalizeFsPath(pagePath));
  if (stem === "index") return "";
  if (stem.endsWith("/index")) stem = stem.slice(0, -"/index".length);
  return stem;
}

function extractDocStemFromAnyPath(path: string): string | null {
  const normalized = normalizeFsPath(path).replace(/^\.\//, "");
  const docsIdx = normalized.indexOf("content/docs/");
  if (docsIdx < 0) return null;

  let stem = stripDocExt(normalized.slice(docsIdx + "content/docs/".length));
  if (stem === "index") return "";
  if (stem.endsWith("/index")) stem = stem.slice(0, -"/index".length);
  return stem;
}

async function resolveDocFilePath(pagePath: string): Promise<string | null> {
  const directPath = resolve(process.cwd(), "content/docs", pagePath);
  const candidates = /\.(md|mdx)$/i.test(directPath)
    ? [directPath]
    : [`${directPath}.mdx`, `${directPath}.md`];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return normalizeFsPath(candidate);
    } catch {
      // continue
    }
  }

  return null;
}

function getLocalMdxImportSpecifiers(raw: string): string[] {
  const matches = Array.from(raw.matchAll(LOCAL_MDX_IMPORT_RE));
  return matches.map((match) => match[1]).filter(Boolean);
}

async function resolveLocalMdxImportPath(
  baseDir: string,
  specifier: string,
): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const directPath = resolve(baseDir, specifier);
  const candidates = /\.(md|mdx)$/i.test(directPath)
    ? [directPath]
    : [`${directPath}.mdx`, `${directPath}.md`];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return normalizeFsPath(candidate);
    } catch {
      // continue
    }
  }

  return null;
}

async function mapImportsToPage(
  filePath: string,
  pageUrl: string,
  map: Map<string, string>,
  visited: Set<string>,
): Promise<void> {
  const normalized = normalizeFsPath(filePath);
  if (visited.has(normalized)) return;
  visited.add(normalized);

  let raw = "";
  try {
    raw = await readFile(normalized, "utf8");
  } catch {
    return;
  }

  const baseDir = dirname(normalized);
  const imports = getLocalMdxImportSpecifiers(raw);
  for (const specifier of imports) {
    const importedPath = await resolveLocalMdxImportPath(baseDir, specifier);
    if (!importedPath) continue;

    if (importedPath.includes("/content/fragments/")) {
      map.set(importedPath, pageUrl);
    }

    await mapImportsToPage(importedPath, pageUrl, map, visited);
  }
}

export async function getFragmentToPageUrlMap(): Promise<Map<string, string>> {
  if (fragmentToPageUrlMapPromise) return fragmentToPageUrlMapPromise;

  fragmentToPageUrlMapPromise = (async () => {
    const map = new Map<string, string>();

    await Promise.all(
      pageInfos.map(async (page) => {
        const pageFilePath = await resolveDocFilePath(page.path);
        if (!pageFilePath) return;
        await mapImportsToPage(pageFilePath, page.url, map, new Set<string>());
      }),
    );

    return map;
  })();

  return fragmentToPageUrlMapPromise;
}

function selectUrlFromFragmentFallback(
  fragmentPath: string,
  basename: string,
): string | null {
  const candidates = docsBasenameToPages.get(basename) ?? [];
  if (candidates.length === 1) return candidates[0].url;
  if (candidates.length === 0) return null;

  const fragmentRoot = fragmentPath
    .split("/content/fragments/")[1]
    ?.split("/")[0];
  if (!fragmentRoot) return null;

  const rooted = candidates.filter((page) =>
    page.stem.startsWith(`${fragmentRoot}/`),
  );
  if (rooted.length === 1) return rooted[0].url;

  return null;
}

export function deriveUrlFromPath(
  path: string | undefined,
  fragmentToPageUrl: Map<string, string>,
): string | null {
  if (!path) return null;

  const normalizedInput = normalizeFsPath(path).replace(/^\.\//, "");
  const absoluteInput = normalizeFsPath(
    normalizedInput.startsWith("/")
      ? normalizedInput
      : resolve(process.cwd(), normalizedInput),
  );

  const docStem =
    extractDocStemFromAnyPath(absoluteInput) ??
    extractDocStemFromAnyPath(normalizedInput);
  if (docStem !== null) return docsStemToUrl.get(docStem) ?? `/${docStem}`;

  const fragmentPath = absoluteInput.includes("/content/fragments/")
    ? absoluteInput
    : null;
  if (fragmentPath) {
    const mapped = fragmentToPageUrl.get(fragmentPath);
    if (mapped) return mapped;

    const basename = stripDocExt(fragmentPath).split("/").pop() ?? "";
    if (basename) {
      return selectUrlFromFragmentFallback(fragmentPath, basename);
    }
  }

  return null;
}

export function normalizeDirectUrlCandidate(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("/")) return trimmed;
  if (trimmed.startsWith("#")) return null;
  if (trimmed.includes("content/")) return null;
  if (/\.(md|mdx)(?:$|[?#])/i.test(trimmed)) return null;

  return `/${trimmed.replace(/^\/+/, "")}`;
}

export function getPageTitleForUrl(url: string): string | undefined {
  return pageTitleByUrl.get(url);
}

export function resolveChunkUrl(params: {
  path?: string;
  directUrl?: string;
  fragmentToPageUrl: Map<string, string>;
}): string | null {
  return (
    deriveUrlFromPath(params.path, params.fragmentToPageUrl) ??
    normalizeDirectUrlCandidate(params.directUrl)
  );
}

export function pickChunkPathCandidate(...values: unknown[]): string | undefined {
  return firstString(...values);
}
