import {
  asRecord,
  firstString,
  humanizeFilename,
} from "@/lib/mixedbread/chunk-utils";
import { getMixedbreadClient } from "@/lib/mixedbread/client";
import {
  getFragmentToPageUrlMap,
  getPageTitleForUrl,
  resolveChunkUrl,
} from "@/lib/mixedbread/source-resolution";
import type { SortedResult } from "fumadocs-core/search/server";

export const runtime = "nodejs";

const SEARCH_TOP_K = 16;
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

interface MixedbreadChunk {
  file_id: string;
  chunk_index: number;
  type?: string;
  text?: string;
  filename?: string;
  generated_metadata?: unknown;
  metadata?: unknown;
}

type CachedSearchResult = {
  expiresAt: number;
  data: SortedResult[];
};

const searchCache = new Map<string, CachedSearchResult>();

function getCacheKey(query: string, tag: string | undefined): string {
  return `${tag ?? ""}\u0000${query.toLowerCase()}`;
}

function readCachedSearch(key: string): SortedResult[] | null {
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    searchCache.delete(key);
    return null;
  }
  return cached.data;
}

function writeCachedSearch(key: string, data: SortedResult[]): void {
  searchCache.set(key, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    data,
  });

  while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next();
    if (oldest.done) break;
    searchCache.delete(oldest.value);
  }
}

function toHeadingId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function extractHeadingTitle(text?: string): string {
  if (!text) return "";
  const firstLine = text.trim().split("\n")[0]?.trim();
  if (!firstLine || !firstLine.startsWith("#")) return "";

  return firstLine.replace(/^#+\s*/, "").trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^---[\s\S]*?---\s*/m, " ")
    .replace(/^\s*import\s+.+$/gm, " ")
    .replace(/^\s*---+\s*$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[>*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetFromText(text?: string, heading?: string): string {
  if (!text) return "";
  const cleaned = stripMarkdown(text);
  if (!cleaned) return "";

  const withoutHeading =
    heading && cleaned.startsWith(heading)
      ? cleaned.slice(heading.length).trim()
      : cleaned;

  if (withoutHeading.length <= 240) return withoutHeading;
  return `${withoutHeading.slice(0, 240).trimEnd()}...`;
}

function toResults(
  chunks: MixedbreadChunk[],
  fragmentToPageUrl: Map<string, string>,
): SortedResult[] {
  const results: SortedResult[] = [];
  const seen = new Set<string>();
  const seenPages = new Set<string>();

  for (const item of chunks) {
    const generated = asRecord(item.generated_metadata);
    const metadata = asRecord(item.metadata);
    const generatedFrontmatter = asRecord(generated.frontmatter);
    const metadataFrontmatter = asRecord(metadata.frontmatter);

    const path = firstString(
      metadata.file_path,
      generated.path,
      metadata.path,
      item.filename,
    );
    const directUrl = firstString(generated.url, metadata.url);
    const url = resolveChunkUrl({
      path,
      directUrl,
      fragmentToPageUrl,
    });
    if (!url) continue;

    const title =
      getPageTitleForUrl(url) ??
      firstString(
        generated.title,
        metadata.title,
        generatedFrontmatter.title,
        metadataFrontmatter.title,
      ) ??
      humanizeFilename(path);

    if (!seenPages.has(url)) {
      seenPages.add(url);
      results.push({
        id: `page:${url}`,
        type: "page",
        content: title,
        url,
      });
    }

    if (item.type === "text" && item.text) {
      const heading = extractHeadingTitle(item.text);
      if (heading) {
        const headingId = `${item.file_id}-${item.chunk_index}-heading`;
        if (!seen.has(headingId)) {
          seen.add(headingId);
          results.push({
            id: headingId,
            type: "heading",
            content: heading,
            url: `${url}#${toHeadingId(heading)}`,
          });
        }
      }

      const snippet = snippetFromText(item.text, heading);
      if (snippet) {
        const textId = `${item.file_id}-${item.chunk_index}-text`;
        if (!seen.has(textId)) {
          seen.add(textId);
          results.push({
            id: textId,
            type: "text",
            content: snippet,
            url,
          });
        }
      }
    }
  }

  return results;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim();
  if (!query) return Response.json([]);

  const tag = url.searchParams
    .get("tag")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)[0];

  const cacheKey = getCacheKey(query, tag);
  const cached = readCachedSearch(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  const storeIdentifier = process.env.MIXEDBREAD_STORE_IDENTIFIER;
  if (!storeIdentifier) {
    return new Response(
      "Missing required environment variable: MIXEDBREAD_STORE_IDENTIFIER",
      { status: 500 },
    );
  }

  try {
    const client = getMixedbreadClient();

    // Start both expensive operations immediately to avoid waterfall latency.
    const fragmentToPageUrlPromise = getFragmentToPageUrlMap();
    const responsePromise = client.stores.search({
      query,
      store_identifiers: [storeIdentifier],
      top_k: SEARCH_TOP_K,
      search_options: { return_metadata: true },
      ...(tag
        ? {
            filters: {
              key: "generated_metadata.tag",
              operator: "eq",
              value: tag,
            },
          }
        : {}),
    });

    const [fragmentToPageUrl, response] = await Promise.all([
      fragmentToPageUrlPromise,
      responsePromise,
    ]);

    const results = toResults(
      response.data as MixedbreadChunk[],
      fragmentToPageUrl,
    );
    writeCachedSearch(cacheKey, results);
    return Response.json(results);
  } catch (error) {
    console.error("Mixedbread search failed:", error);
    return new Response("Failed to search Mixedbread store", { status: 502 });
  }
}
