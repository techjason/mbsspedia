export const CHUNK_MAX_CHARS = 2200;
export const CHUNK_OVERLAP_CHARS = 200;
export const CHUNKING_VERSION = "v1";

export function previewText(text, length = 120) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .slice(0, length);
}

export function toTokens(value) {
  return Array.from(
    new Set(
      String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

export function buildTopicTerms(topic) {
  const terms = new Set(toTokens(topic));

  const synonymMap = {
    pancreatitis: ["pancreas", "pancreatic", "hbp", "hepatobiliary"],
    pancreas: ["pancreatic", "pancreatitis"],
    intestinal: ["bowel", "gut", "ileus", "obstruction"],
    bowel: ["intestinal", "colorectal", "gut"],
    cancer: ["carcinoma", "malignancy", "tumour", "tumor", "oncology"],
    carcinoma: ["cancer", "malignancy"],
    hernia: ["inguinal", "femoral", "umbilical", "incisional"],
    thyroid: ["goitre", "goiter", "endocrine"],
    cholangitis: ["biliary", "gallstone", "cholecystitis"],
    cholangio: ["biliary", "cholangitis"],
    liver: ["hepatic", "hbp", "hepatobiliary"],
    breast: ["mammary"],
    trauma: ["injury", "shock", "resuscitation"],
    stroke: ["cerebrovascular", "intracranial"],
    appendicitis: ["appendix", "rlq", "acute abdomen"],
    jaundice: ["biliary", "hepatobiliary", "cholestasis"],
    obstruction: ["occlusion", "ileus"],
    bleeding: ["haemorrhage", "hemorrhage", "ugib", "lgib"],
  };

  for (const token of Array.from(terms)) {
    const directSynonyms = synonymMap[token] ?? [];
    for (const synonym of directSynonyms) {
      terms.add(synonym);
    }

    if (token.endsWith("s") && token.length > 4) {
      terms.add(token.slice(0, -1));
    }
  }

  const topicLower = String(topic ?? "").toLowerCase();
  for (const [key, synonyms] of Object.entries(synonymMap)) {
    if (topicLower.includes(key)) {
      terms.add(key);
      for (const synonym of synonyms) {
        terms.add(synonym);
      }
    }
  }

  return Array.from(terms);
}

export function lexicalScore(text, terms) {
  const lower = String(text ?? "").toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (!term) {
      continue;
    }

    if (lower.includes(term)) {
      score += term.length >= 6 ? 3 : 1;
    }
  }

  return score;
}

export function splitLongSection(text, maxChars = CHUNK_MAX_CHARS, overlapChars = CHUNK_OVERLAP_CHARS) {
  const normalized = String(text ?? "");
  const parts = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);

    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + Math.floor(maxChars * 0.5)) {
        end = paragraphBreak + 2;
      }
    }

    parts.push(normalized.slice(start, end));

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(start + 1, end - overlapChars);
  }

  return parts;
}

export function splitIntoSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections = [];
  let current = [];

  const headingPattern = /^(#{1,6}\s+|chapter\s+\d+[:\s])/i;

  for (const line of lines) {
    const isHeading = headingPattern.test(line.trim());

    if (isHeading && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    sections.push(current.join("\n"));
  }

  return sections.filter((section) => section.trim().length > 0);
}

export function buildChunksFromText({ text, prefix, sourceName, sourcePath }) {
  const sections = splitIntoSections(text);
  const chunks = [];

  let index = 1;
  for (const section of sections) {
    const parts = splitLongSection(section, CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS);

    for (const part of parts) {
      if (!part.trim()) {
        continue;
      }

      chunks.push({
        id: `${prefix}:${index}`,
        sourceName,
        sourcePath,
        text: part,
      });
      index += 1;
    }
  }

  return chunks;
}

export function normalizeMinMax(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      continue;
    }
    if (n < min) {
      min = n;
    }
    if (n > max) {
      max = n;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return values.map(() => 0);
  }

  return values.map((value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return 0;
    }
    return (n - min) / (max - min);
  });
}
