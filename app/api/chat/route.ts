import {
  convertToModelMessages,
  gateway,
  streamText,
  type UIMessage,
} from "ai";
import {
  asRecord,
  clipText,
  deriveSourceArticleName,
  firstString,
  getChunkPath,
  type MixedbreadChunkLike,
} from "@/lib/mixedbread/chunk-utils";
import { getMixedbreadClient, getRequiredEnv } from "@/lib/mixedbread/client";
import {
  getFragmentToPageUrlMap,
  resolveChunkUrl,
} from "@/lib/mixedbread/source-resolution";

export const runtime = "nodejs";

const SEARCH_TOP_K = 12;
const MAX_CHUNK_CHARS = 1000;
const MAX_CONTEXT_CHUNKS = 10;
const WEAK_RETRIEVAL_SCORE_THRESHOLD = 0.45;
const WEAK_RETRIEVAL_CHAR_THRESHOLD = 280;

const FRAGMENT_LABELS: Record<string, string> = {
  etiology: "Etiology",
  ddx: "DDx",
  dx: "Dx",
  mx: "Mx",
  management: "Management",
  complications: "Complications",
  summary: "Summary",
};

type PageContext = {
  pathname?: string;
  title?: string;
};

type ChatRequestBody = {
  messages?: UIMessage[];
  pageContext?: PageContext;
};

type MixedbreadScoredChunk = MixedbreadChunkLike & {
  file_id: string;
  chunk_index: number;
  type?: string;
  text?: string;
  filename?: string;
  score: number;
  metadata?: unknown;
  generated_metadata?: unknown;
};

type CitationSource = {
  n: number;
  key: string;
  sourceName: string;
};

type RetrievedChunk = {
  chunkId: string;
  citationNumber: number;
  sourceName: string;
  score: number;
  text: string;
};

function getMessageText(message: UIMessage): string {
  let output = "";
  for (const part of message.parts ?? []) {
    if (part.type === "text") {
      output += part.text;
    }
  }
  return output.trim();
}

function getLatestUserQuery(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = getMessageText(message);
    if (text.length > 0) return text;
  }

  return "";
}

function normalizePageContext(value: unknown): PageContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const pathname =
    typeof record.pathname === "string" && record.pathname.trim().length > 0
      ? record.pathname.trim()
      : undefined;
  const title =
    typeof record.title === "string" && record.title.trim().length > 0
      ? record.title.trim()
      : undefined;

  if (!pathname && !title) {
    return undefined;
  }

  return { pathname, title };
}

function deriveFragmentLabelFromPath(path?: string): string | undefined {
  if (!path) return undefined;

  const normalized = path.replace(/\\/g, "/");
  const marker = "/content/fragments/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return undefined;

  const relative = normalized.slice(markerIndex + marker.length);
  const parts = relative.split("/").filter(Boolean);
  const leaf = parts.at(-1)?.replace(/\.(md|mdx)$/i, "").toLowerCase();
  if (!leaf) return undefined;

  return FRAGMENT_LABELS[leaf] ?? leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

function deriveHeadingHint(item: MixedbreadScoredChunk): string | undefined {
  const generated = asRecord(item.generated_metadata);

  const headingContext = generated.heading_context;
  if (Array.isArray(headingContext) && headingContext.length > 0) {
    const last = headingContext[headingContext.length - 1];
    const label = firstString(asRecord(last).text);
    if (label) return label.trim();
  }

  const chunkHeadings = generated.chunk_headings;
  if (Array.isArray(chunkHeadings) && chunkHeadings.length > 0) {
    const last = chunkHeadings[chunkHeadings.length - 1];
    const label = firstString(asRecord(last).text);
    if (label) return label.trim();
  }

  return undefined;
}

function formatCitationSourceName(params: {
  articleName: string;
  url?: string | null;
  fragmentLabel?: string;
  headingHint?: string;
}): string {
  const article = params.url
    ? `[${params.articleName}](${params.url})`
    : params.articleName;
  const section = params.fragmentLabel ?? params.headingHint;

  if (!section) return article;
  return `${article} (${section})`;
}

async function retrieveCitationContext(query: string): Promise<{
  chunks: RetrievedChunk[];
  sources: CitationSource[];
  isWeak: boolean;
}> {
  const storeIdentifier = getRequiredEnv("MIXEDBREAD_STORE_IDENTIFIER");
  const client = getMixedbreadClient();

  const fragmentToPageUrlPromise = getFragmentToPageUrlMap();
  const responsePromise = client.stores.search({
    query,
    store_identifiers: [storeIdentifier],
    top_k: SEARCH_TOP_K,
    search_options: { return_metadata: true, rerank: true },
  });

  const [fragmentToPageUrl, response] = await Promise.all([
    fragmentToPageUrlPromise,
    responsePromise,
  ]);

  const data = (response.data ?? []) as MixedbreadScoredChunk[];
  const sourceByKey = new Map<string, CitationSource>();
  const chunks: RetrievedChunk[] = [];

  for (const item of data) {
    if (item.type && item.type !== "text") continue;
    const rawText = item.text?.trim();
    if (!rawText) continue;

    const generated = asRecord(item.generated_metadata);
    const metadata = asRecord(item.metadata);
    const filePath = getChunkPath(item);
    const sourceKey = filePath || item.filename || item.file_id;

    let source = sourceByKey.get(sourceKey);
    if (!source) {
      const directUrl = firstString(generated.url, metadata.url);
      const url = resolveChunkUrl({
        path: filePath,
        directUrl,
        fragmentToPageUrl,
      });

      source = {
        n: sourceByKey.size + 1,
        key: sourceKey,
        sourceName: formatCitationSourceName({
          articleName: deriveSourceArticleName({
            path: filePath,
            filename: item.filename,
          }),
          url,
          fragmentLabel: deriveFragmentLabelFromPath(filePath),
          headingHint: deriveHeadingHint(item),
        }),
      };
      sourceByKey.set(sourceKey, source);
    }

    chunks.push({
      chunkId: `${item.file_id}:${item.chunk_index}`,
      citationNumber: source.n,
      sourceName: source.sourceName,
      score: Number.isFinite(item.score) ? item.score : 0,
      text: rawText,
    });
  }

  chunks.sort((a, b) => b.score - a.score);
  const trimmedChunks = chunks.slice(0, MAX_CONTEXT_CHUNKS);
  const totalChars = trimmedChunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const topScore = trimmedChunks[0]?.score ?? 0;
  const isWeak =
    trimmedChunks.length === 0 ||
    topScore < WEAK_RETRIEVAL_SCORE_THRESHOLD ||
    totalChars < WEAK_RETRIEVAL_CHAR_THRESHOLD;

  return {
    chunks: trimmedChunks,
    sources: Array.from(sourceByKey.values()).sort((a, b) => a.n - b.n),
    isWeak,
  };
}

function buildCitationMapBlock(sources: CitationSource[]): string {
  if (sources.length === 0) {
    return "(none)";
  }

  return sources.map((source) => `[${source.n}] ${source.sourceName}`).join("\n");
}

function buildChunkContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "(none)";
  }

  return chunks
    .map(
      (chunk, index) =>
        `Chunk ${index + 1} | Source [${chunk.citationNumber}] ${chunk.sourceName} | Score ${chunk.score.toFixed(3)}\n${clipText(chunk.text, MAX_CHUNK_CHARS)}`,
    )
    .join("\n\n");
}

function buildSystemPrompt({
  pageContext,
  sources,
  chunks,
  isWeak,
}: {
  pageContext?: PageContext;
  sources: CitationSource[];
  chunks: RetrievedChunk[];
  isWeak: boolean;
}): string {
  const pageHint = [
    pageContext?.pathname ? `pathname: ${pageContext.pathname}` : null,
    pageContext?.title ? `title: ${pageContext.title}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const retrievalStatus = isWeak ? "WEAK_OR_EMPTY" : "STRONG";

  return [
    "You are a helpful assistant in a medical knowledge base called MBBSPedia.",
    "Never say you are 'not a doctor' and you are not qualified.",
    "",
    "You must follow citation rules strictly:",
    "- Use inline numeric citations only, like [1], [2], [3].",
    "- Reuse the same citation number for the same source consistently.",
    "- Only use citation numbers from the provided citation map.",
    "- Never invent sources, citation numbers, or references.",
    "- If you use any inline citations, end with exactly one '## References' section.",
    "- In that section, list each cited source once as '[n] Source Name'.",
    "",
    "If retrieval status is WEAK_OR_EMPTY:",
    "- Start the answer with: 'Evidence warning: Retrieved context is limited for this query.'",
    "- You may still provide a cautious general answer.",
    "- Do not fabricate citations. If no source-supported claim is used, do not output references.",
    "",
    "Current page context hint (do not treat as source):",
    pageHint || "(none)",
    "",
    `Retrieval status: ${retrievalStatus}`,
    "",
    "Citation map:",
    buildCitationMapBlock(sources),
    "",
    "Retrieved evidence chunks:",
    buildChunkContextBlock(chunks),
  ].join("\n");
}

function extractAssistantText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function parseReferencesBlock(answerText: string): Map<number, string> {
  const references = new Map<number, string>();
  const headingMatch = answerText.match(/^##\s+References\s*$/im);
  if (!headingMatch || headingMatch.index === undefined) {
    return references;
  }

  const start = answerText.slice(headingMatch.index + headingMatch[0].length);
  const untilNextHeading = start.split(/\n##\s+/)[0];

  for (const rawLine of untilNextHeading.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^\[(\d+)\]\s+(.+)$/);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (!Number.isFinite(n) || n < 1) continue;
    references.set(n, match[2].trim());
  }

  return references;
}

function validateCitationIntegrity(params: {
  answerText: string;
  sources: CitationSource[];
  isWeak: boolean;
}): void {
  const sourceByNumber = new Map(params.sources.map((source) => [source.n, source.sourceName]));
  const referencesHeading = params.answerText.match(/^##\s+References\s*$/im);
  const answerBody =
    referencesHeading && referencesHeading.index !== undefined
      ? params.answerText.slice(0, referencesHeading.index)
      : params.answerText;
  const citationMatches = Array.from(answerBody.matchAll(/\[(\d+)\]/g));
  const inlineNumbers = Array.from(
    new Set(
      citationMatches
        .map((match) => Number.parseInt(match[1], 10))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ).sort((a, b) => a - b);
  const references = parseReferencesBlock(params.answerText);
  const issues: string[] = [];

  for (const n of inlineNumbers) {
    if (!sourceByNumber.has(n)) {
      issues.push(`inline citation [${n}] is not in citation map`);
    }
  }

  if (inlineNumbers.length > 0 && references.size === 0) {
    issues.push("inline citations are present but references block is missing");
  }

  if (inlineNumbers.length === 0 && references.size > 0) {
    issues.push("references block is present without inline citations");
  }

  for (const [n, label] of references.entries()) {
    const expected = sourceByNumber.get(n);
    if (!expected) {
      issues.push(`reference [${n}] is not in citation map`);
      continue;
    }
    if (expected.toLowerCase() !== label.toLowerCase()) {
      issues.push(`reference [${n}] label mismatch (expected '${expected}', got '${label}')`);
    }
  }

  if (!params.isWeak && params.sources.length > 0 && inlineNumbers.length === 0) {
    issues.push("strong retrieval context provided but no inline citations were emitted");
  }

  if (issues.length > 0) {
    console.warn(
      "[chat-citation-validation]",
      JSON.stringify({
        issues,
        inlineNumbers,
        references: Array.from(references.entries()),
        citationMap: Array.from(sourceByNumber.entries()),
      }),
    );
  }
}

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json({ error: "messages are required." }, { status: 400 });
  }

  const userQuery = getLatestUserQuery(messages);
  const pageContext = normalizePageContext(body.pageContext);

  let retrieval: { chunks: RetrievedChunk[]; sources: CitationSource[]; isWeak: boolean } = {
    chunks: [],
    sources: [],
    isWeak: true,
  };

  if (userQuery) {
    try {
      retrieval = await retrieveCitationContext(userQuery);
    } catch (error) {
      console.error("[chat-retrieval-failed]", error);
    }
  }

  const systemPrompt = buildSystemPrompt({
    pageContext,
    sources: retrieval.sources,
    chunks: retrieval.chunks,
    isWeak: retrieval.isWeak,
  });

  const result = streamText({
    model: gateway("google/gemini-3-flash"),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: ({ responseMessage }) => {
      const assistantText = extractAssistantText(responseMessage);
      validateCitationIntegrity({
        answerText: assistantText,
        sources: retrieval.sources,
        isWeak: retrieval.isWeak,
      });
    },
  });
}
