import { cosineSimilarity } from "ai";
import {
  buildTopicTerms,
  lexicalScore,
  normalizeMinMax,
  previewText,
} from "./rag-chunking.mjs";

const SECTION_QUERY_MAP = {
  Etiology:
    "definition epidemiology risk factors etiology pathophysiology anatomy clinical basis",
  DDx: "differential diagnosis distinguishing features red flags pitfalls",
  Dx: "diagnostic criteria diagnostic algorithm investigations interpretation findings",
  Mx: "management algorithm treatment indications contraindications supportive care",
  Complications: "complications sequelae prognosis prevention follow-up",
};

export function buildSectionQuery(topic, sectionName) {
  const sectionHint = SECTION_QUERY_MAP[sectionName] ?? sectionName.toLowerCase();
  return `${topic}\nSection: ${sectionName}\nFocus: ${sectionHint}`;
}

export function rankSlideFilesByHybrid({
  topic,
  slideFiles,
  queryEmbedding,
  lexicalWeight = 0.45,
  semanticWeight = 0.55,
}) {
  const terms = buildTopicTerms(topic);
  const lexicalRaw = slideFiles.map((file) =>
    lexicalScore(`${file.fileName}\n${file.summaryText ?? ""}`, terms),
  );
  const semanticRaw = slideFiles.map((file) => {
    if (!queryEmbedding || !Array.isArray(file.summaryEmbedding)) {
      return 0;
    }

    try {
      return cosineSimilarity(queryEmbedding, file.summaryEmbedding);
    } catch {
      return 0;
    }
  });

  const lexicalNorm = normalizeMinMax(lexicalRaw);
  const semanticNorm = normalizeMinMax(semanticRaw);

  return slideFiles
    .map((file, index) => ({
      ...file,
      lexicalScore: lexicalRaw[index],
      semanticScore: semanticRaw[index],
      score:
        lexicalWeight * lexicalNorm[index] + semanticWeight * semanticNorm[index],
    }))
    .sort((a, b) => b.score - a.score || a.fileName.localeCompare(b.fileName));
}

export function rankChunksHybrid({
  query,
  chunks,
  embeddingById,
  queryEmbedding,
  lexicalWeight = 0.4,
  semanticWeight = 0.6,
}) {
  const terms = buildTopicTerms(query);
  const lexicalRaw = chunks.map((chunk) => lexicalScore(chunk.text, terms));
  const semanticRaw = chunks.map((chunk) => {
    if (!queryEmbedding) {
      return 0;
    }

    const embedding = embeddingById.get(chunk.id);
    if (!Array.isArray(embedding)) {
      return 0;
    }

    try {
      return cosineSimilarity(queryEmbedding, embedding);
    } catch {
      return 0;
    }
  });

  const lexicalNorm = normalizeMinMax(lexicalRaw);
  const semanticNorm = normalizeMinMax(semanticRaw);

  return chunks
    .map((chunk, index) => ({
      ...chunk,
      lexicalScore: lexicalRaw[index],
      semanticScore: semanticRaw[index],
      score:
        lexicalWeight * lexicalNorm[index] + semanticWeight * semanticNorm[index],
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function mergeSourceBalanced({
  rankedFelix,
  rankedMaxim,
  rankedSlides,
  perSourceCap = 12,
  candidateLimit = 60,
}) {
  const topFelix = rankedFelix.slice(0, perSourceCap).map((item) => ({
    ...item,
    sourceGroup: "felix",
  }));
  const topMaxim = rankedMaxim.slice(0, perSourceCap).map((item) => ({
    ...item,
    sourceGroup: "maxim",
  }));
  const topSlides = rankedSlides.slice(0, perSourceCap).map((item) => ({
    ...item,
    sourceGroup: "slides",
  }));

  const merged = [...topFelix, ...topMaxim, ...topSlides];
  merged.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return merged.slice(0, candidateLimit);
}

export function assembleSectionContext({
  selectedChunks,
  contextBudgetChars = 28000,
}) {
  const groupedTitles = {
    felix: "### Felix Scout (Indexed)",
    maxim: "### Maxim Scout (Indexed)",
    slides: "### BlockB Slides (Indexed)",
  };

  const selected = [];
  let usedChars = 0;

  for (const chunk of selectedChunks) {
    const estimatedSize = chunk.text.length + 220;
    if (usedChars + estimatedSize > contextBudgetChars) {
      continue;
    }

    selected.push(chunk);
    usedChars += estimatedSize;
  }

  const groupOrder = ["felix", "maxim", "slides"];
  const parts = [];
  for (const group of groupOrder) {
    const groupItems = selected.filter((item) => item.sourceGroup === group);
    if (groupItems.length === 0) {
      continue;
    }

    parts.push(groupedTitles[group]);
    for (const item of groupItems) {
      parts.push(`#### [${item.id}] Source: ${item.sourceName}\n${item.text}`);
    }
  }

  return {
    contextText: parts.join("\n\n"),
    usedChars,
    selected,
  };
}

export function summarizeCandidatePreview(candidates, limit = 5) {
  return candidates.slice(0, limit).map((candidate) => ({
    id: candidate.id,
    source: candidate.sourceName,
    score: candidate.score,
    preview: previewText(candidate.text),
  }));
}
