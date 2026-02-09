#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseEnv, promisify } from "node:util";
import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNKING_VERSION,
  buildChunksFromText,
  splitLongSection,
} from "./lib/rag-chunking.mjs";
import {
  absFromCache,
  ensureDir,
  fingerprintFile,
  isFingerprintMatch,
  readManifest,
  relFromCache,
  resolveCachePaths,
  writeJsonAtomic,
  writeManifest,
} from "./lib/rag-cache.mjs";
import {
  DEFAULT_EMBEDDING_MODEL,
  embedSingleValue,
  embedValues,
} from "./lib/rag-embed.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_SPECIALTY = "general-surgery";
const DEFAULT_SLIDES_DIR = "/Users/jason/Documents/BlockBSlides";
const DEFAULT_PSYCHIATRY_SLIDES_DIR = "/Users/jason/Documents/PyschiatrySlides";
const DEFAULT_CACHE_ROOT = ".cache/rag";
const DEFAULT_SURGERY_CACHE_DIR = `${DEFAULT_CACHE_ROOT}/surgery`;
const DEFAULT_OCR_POLICY = "smart";
const SUMMARY_MAX_CHARS = 7000;

const DEFAULT_SENIOR_NOTES = [
  { id: "felix", path: "scripts/felixlai.md", label: "Felix Lai" },
  { id: "maxim", path: "scripts/maxim.md", label: "Maxim" },
];
const DEFAULT_PSYCHIATRY_SENIOR_NOTES = [
  {
    id: "ryanho-psych",
    path: "scripts/ryanho-psych.md",
    label: "Ryan Ho (Psychiatry)",
  },
];

function printUsage() {
  console.log(`Usage:
  npm run index:rag -- [options]

Options:
  --specialty "<name>"         Default: ${DEFAULT_SPECIALTY}
  --senior-note "<path>"       Add a senior note (repeatable).
                               Format: "<label>=<path>" or "<path>".
  --felix-note "<path>"        Backward-compatible alias for senior note slot #1.
  --maxim-note "<path>"        Backward-compatible alias for senior note slot #2.
  --psychiatry                 Shortcut preset:
                               specialty=psychiatry
                               slides-dir=${DEFAULT_PSYCHIATRY_SLIDES_DIR}
                               senior-note=${DEFAULT_PSYCHIATRY_SENIOR_NOTES[0].path}
  --slides-dir "<path>"         Default: ${DEFAULT_SLIDES_DIR}
  --embedding-model "<id>"      Default: ${DEFAULT_EMBEDDING_MODEL}
  --cache-dir "<path>"          Default: ${DEFAULT_SURGERY_CACHE_DIR}
  --ocr-policy <smart|always|off> Default: ${DEFAULT_OCR_POLICY}
  --force                       Rebuild all artifacts
  --help                        Show this help

Examples:
  npm run index:rag -- --slides-dir "/Users/jason/Documents/BlockBSlides"
  npm run index:rag -- --psychiatry
  npm run index:rag -- --specialty psychiatry --senior-note "/path/to/psychiatry-senior.md" --slides-dir "/path/to/psychiatry/slides"
  npm run index:rag -- --force --ocr-policy always
`);
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function parseSeniorNoteSpec(rawValue, fallbackIndex) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    throw new Error("--senior-note requires a value");
  }

  let label = "";
  let notePath = raw;
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex > 0) {
    label = raw.slice(0, separatorIndex).trim();
    notePath = raw.slice(separatorIndex + 1).trim();
  }

  if (!notePath) {
    throw new Error(`Invalid --senior-note value: ${rawValue}`);
  }

  const fallbackLabel =
    label || path.basename(notePath, path.extname(notePath)) || `note-${fallbackIndex + 1}`;
  const id = slugify(fallbackLabel) || `note-${fallbackIndex + 1}`;
  return { id, path: notePath, label: fallbackLabel };
}

function upsertSeniorNote(notes, entry) {
  const next = Array.isArray(notes) ? notes.slice() : [];
  const index = next.findIndex((note) => note.id === entry.id);
  if (index >= 0) {
    next[index] = entry;
    return next;
  }
  next.push(entry);
  return next;
}

function parseArgs(argv) {
  const options = {
    specialty: DEFAULT_SPECIALTY,
    slidesDir: DEFAULT_SLIDES_DIR,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    cacheDir: DEFAULT_SURGERY_CACHE_DIR,
    cacheDirExplicit: false,
    slidesDirExplicit: false,
    seniorNotesExplicit: false,
    seniorNotes: DEFAULT_SENIOR_NOTES.slice(),
    ocrPolicy: DEFAULT_OCR_POLICY,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--specialty") {
      options.specialty = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--psychiatry" || arg === "-psychiatry") {
      options.specialty = "psychiatry";
      options.seniorNotes = DEFAULT_PSYCHIATRY_SENIOR_NOTES.slice();
      options.seniorNotesExplicit = false;
      options.slidesDir = DEFAULT_PSYCHIATRY_SLIDES_DIR;
      options.slidesDirExplicit = false;
      continue;
    }

    if (arg === "--surgery" || arg === "-surgery") {
      options.specialty = DEFAULT_SPECIALTY;
      options.seniorNotes = DEFAULT_SENIOR_NOTES.slice();
      options.seniorNotesExplicit = false;
      options.slidesDir = DEFAULT_SLIDES_DIR;
      options.slidesDirExplicit = false;
      continue;
    }

    if (arg === "--senior-note") {
      if (!options.seniorNotesExplicit) {
        options.seniorNotes = [];
        options.seniorNotesExplicit = true;
      }
      const note = parseSeniorNoteSpec(argv[i + 1], options.seniorNotes.length);
      options.seniorNotes = upsertSeniorNote(options.seniorNotes, note);
      i += 1;
      continue;
    }

    if (arg === "--felix-note") {
      options.seniorNotesExplicit = true;
      options.seniorNotes = upsertSeniorNote(options.seniorNotes, {
        id: "felix",
        path: argv[i + 1],
        label: "Felix Lai",
      });
      i += 1;
      continue;
    }

    if (arg === "--maxim-note") {
      options.seniorNotesExplicit = true;
      options.seniorNotes = upsertSeniorNote(options.seniorNotes, {
        id: "maxim",
        path: argv[i + 1],
        label: "Maxim",
      });
      i += 1;
      continue;
    }

    if (arg === "--slides-dir") {
      options.slidesDir = argv[i + 1];
      options.slidesDirExplicit = true;
      i += 1;
      continue;
    }

    if (arg === "--embedding-model") {
      options.embeddingModel = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--cache-dir") {
      options.cacheDir = argv[i + 1];
      options.cacheDirExplicit = true;
      i += 1;
      continue;
    }

    if (arg === "--ocr-policy") {
      const value = String(argv[i + 1] ?? "").toLowerCase();
      if (!["smart", "always", "off"].includes(value)) {
        throw new Error(`Invalid --ocr-policy value: ${argv[i + 1]}`);
      }
      options.ocrPolicy = value;
      i += 1;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.help) {
    return options;
  }

  const normalizedSpecialty = slugify(options.specialty) || DEFAULT_SPECIALTY;
  options.specialty = normalizedSpecialty;

  if (!options.cacheDirExplicit) {
    options.cacheDir =
      normalizedSpecialty === DEFAULT_SPECIALTY
        ? DEFAULT_SURGERY_CACHE_DIR
        : `${DEFAULT_CACHE_ROOT}/${normalizedSpecialty}`;
  }

  if (normalizedSpecialty === "psychiatry") {
    if (!options.seniorNotesExplicit) {
      options.seniorNotes = DEFAULT_PSYCHIATRY_SENIOR_NOTES.slice();
    }
    if (!options.slidesDirExplicit) {
      options.slidesDir = DEFAULT_PSYCHIATRY_SLIDES_DIR;
    }
  }

  if (options.seniorNotes.length === 0) {
    throw new Error("At least one senior note is required. Use --senior-note.");
  }

  if (normalizedSpecialty !== DEFAULT_SPECIALTY) {
    if (normalizedSpecialty !== "psychiatry" && !options.seniorNotesExplicit) {
      throw new Error(
        `Specialty "${normalizedSpecialty}" requires explicit senior notes. Use --senior-note "<path>".`,
      );
    }
    if (normalizedSpecialty !== "psychiatry" && !options.slidesDirExplicit) {
      throw new Error(
        `Specialty "${normalizedSpecialty}" requires an explicit slides directory. Use --slides-dir "<path>".`,
      );
    }
  }

  return options;
}

async function loadDotEnvFiles() {
  const envFiles = [".env.local", ".env"];

  for (const envFile of envFiles) {
    const absolutePath = path.join(process.cwd(), envFile);

    let content;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }

    const parsed = parseEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

async function commandExists(command, versionArgs = ["--version"]) {
  try {
    await execFileAsync(command, versionArgs, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function listSlidePdfs(slidesDir) {
  const absoluteSlidesDir = path.resolve(process.cwd(), slidesDir);

  try {
    const entries = await readdir(absoluteSlidesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => ({
        fileName: entry.name,
        absolutePath: path.join(absoluteSlidesDir, entry.name),
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      console.warn(`[Slides] Directory not found: ${absoluteSlidesDir}`);
      return [];
    }

    throw error;
  }
}

function parsePagesCount(mutoolInfoOutput) {
  const match = String(mutoolInfoOutput ?? "").match(/Pages:\s+(\d+)/);
  if (!match) {
    return 1;
  }

  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return parsed;
}

function alphaCharRatio(text) {
  const normalized = String(text ?? "").replace(/\s+/g, "");
  if (!normalized) {
    return 0;
  }

  const alphaMatches = normalized.match(/[a-z]/gi) ?? [];
  return alphaMatches.length / normalized.length;
}

function shouldOcrPage({ policy, text }) {
  if (policy === "off") {
    return false;
  }

  if (policy === "always") {
    return true;
  }

  const trimmed = String(text ?? "").trim();
  const textLength = trimmed.length;
  const alphaRatio = alphaCharRatio(trimmed);
  return textLength < 120 || alphaRatio < 0.35;
}

async function renderPageToPng({ pdfPath, pageNumber }) {
  const tempFile = path.join(
    os.tmpdir(),
    `rag-ocr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}-${pageNumber}.png`,
  );

  await execFileAsync(
    "mutool",
    ["draw", "-F", "png", "-r", "300", "-o", tempFile, pdfPath, `${pageNumber}`],
    {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return tempFile;
}

function mergeMutoolAndOcrText(mutoolText, ocrText) {
  const mutool = String(mutoolText ?? "").trim();
  const ocr = String(ocrText ?? "").trim();

  if (!mutool) {
    return ocr;
  }
  if (!ocr) {
    return mutool;
  }

  if (ocr.length >= mutool.length * 1.5) {
    return ocr;
  }

  const dedup = new Set();
  const mergedLines = [];
  for (const line of `${mutool}\n${ocr}`.split(/\r?\n/)) {
    const normalized = line.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (dedup.has(normalized)) {
      continue;
    }
    dedup.add(normalized);
    mergedLines.push(line.trim());
  }

  return mergedLines.join("\n");
}

async function extractPdfPagesWithOcr({
  pdfPath,
  ocrPolicy,
  tesseractAvailable,
}) {
  const info = await execFileAsync("mutool", ["info", pdfPath], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000,
  });

  const pageCount = parsePagesCount(info.stdout);
  const draw = await execFileAsync(
    "mutool",
    ["draw", "-F", "txt", "-o", "-", pdfPath, `1-${pageCount}`],
    {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 180000,
    },
  );

  const split = String(draw.stdout ?? "").split("\f");
  const pages = [];

  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = index + 1;
    const mutoolText = split[index] ?? "";
    let finalText = mutoolText;
    let ocrApplied = false;

    if (shouldOcrPage({ policy: ocrPolicy, text: mutoolText })) {
      if (tesseractAvailable) {
        let pngPath;
        try {
          pngPath = await renderPageToPng({ pdfPath, pageNumber });
          const ocr = await execFileAsync(
            "tesseract",
            [pngPath, "stdout", "--psm", "6"],
            {
              timeout: 120000,
              maxBuffer: 25 * 1024 * 1024,
            },
          );
          finalText = mergeMutoolAndOcrText(mutoolText, ocr.stdout ?? "");
          ocrApplied = true;
        } catch (error) {
          console.warn(
            `[OCR] Failed on ${path.basename(pdfPath)} page ${pageNumber}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          if (pngPath) {
            await unlink(pngPath).catch(() => {});
          }
        }
      }
    }

    pages.push({
      pageNumber,
      text: String(finalText ?? "").trim(),
      mutoolChars: String(mutoolText ?? "").trim().length,
      finalChars: String(finalText ?? "").trim().length,
      ocrApplied,
    });
  }

  return pages;
}

function buildSlideChunksFromPages({ fileName, sourcePath, pages }) {
  const chunks = [];

  for (const page of pages) {
    if (!page.text.trim()) {
      continue;
    }

    const parts = splitLongSection(page.text, CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS);

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part.trim()) {
        continue;
      }

      const partIndex = i + 1;
      chunks.push({
        id: `slide:${fileName}:p${page.pageNumber}:${partIndex}`,
        sourceName: fileName,
        sourcePath,
        text: part,
      });
    }
  }

  return chunks;
}

function buildPdfSummary({ fileName, pages, maxChars = SUMMARY_MAX_CHARS }) {
  const pageSnippets = [];

  for (const page of pages) {
    const trimmed = String(page.text ?? "").replace(/\s+/g, " ").trim();
    if (!trimmed) {
      continue;
    }

    pageSnippets.push(`Page ${page.pageNumber}: ${trimmed.slice(0, 600)}`);
  }

  const header = `File: ${fileName}`;
  let summary = header;
  for (const snippet of pageSnippets) {
    const next = `${summary}\n${snippet}`;
    if (next.length > maxChars) {
      break;
    }
    summary = next;
  }

  return summary;
}

function hasAllArtifactFiles(paths) {
  return Promise.all(
    paths.map(async (filePath) => {
      try {
        await readFile(filePath, "utf8");
        return true;
      } catch {
        return false;
      }
    }),
  ).then((results) => results.every(Boolean));
}

async function indexPdf({
  pdf,
  fingerprint,
  options,
  cacheBaseDir,
  tesseractAvailable,
}) {
  const pdfDir = path.join(cacheBaseDir, "pdf", fingerprint.sha256);
  await ensureDir(pdfDir);

  const pages = await extractPdfPagesWithOcr({
    pdfPath: pdf.absolutePath,
    ocrPolicy: options.ocrPolicy,
    tesseractAvailable,
  });
  const summary = buildPdfSummary({ fileName: pdf.fileName, pages });
  const chunks = buildSlideChunksFromPages({
    fileName: pdf.fileName,
    sourcePath: pdf.absolutePath,
    pages,
  });

  const { embedding: summaryEmbedding, usage: summaryUsage } = await embedSingleValue({
    model: options.embeddingModel,
    value: summary,
  });

  const chunkValues = chunks.map((chunk) => chunk.text);
  const { embeddings: chunkEmbeddings, usage: chunkUsage } = await embedValues({
    model: options.embeddingModel,
    values: chunkValues,
  });

  const pagesPath = path.join(pdfDir, "pages.json");
  const summaryPath = path.join(pdfDir, "summary.json");
  const summaryEmbeddingPath = path.join(pdfDir, "summary.embedding.json");
  const chunksPath = path.join(pdfDir, "chunks.json");
  const chunksEmbeddingPath = path.join(pdfDir, "chunks.embedding.json");

  await writeJsonAtomic(pagesPath, {
    fileName: pdf.fileName,
    sourcePath: pdf.absolutePath,
    pageCount: pages.length,
    indexedAt: new Date().toISOString(),
    ocrPolicy: options.ocrPolicy,
    pages,
  });

  await writeJsonAtomic(summaryPath, {
    fileName: pdf.fileName,
    sourcePath: pdf.absolutePath,
    indexedAt: new Date().toISOString(),
    summary,
  });

  await writeJsonAtomic(summaryEmbeddingPath, {
    fileName: pdf.fileName,
    sourcePath: pdf.absolutePath,
    modelId: options.embeddingModel,
    indexedAt: new Date().toISOString(),
    usage: summaryUsage,
    embedding: summaryEmbedding,
  });

  await writeJsonAtomic(chunksPath, {
    fileName: pdf.fileName,
    sourcePath: pdf.absolutePath,
    modelId: options.embeddingModel,
    chunkingVersion: CHUNKING_VERSION,
    indexedAt: new Date().toISOString(),
    chunks,
  });

  await writeJsonAtomic(chunksEmbeddingPath, {
    fileName: pdf.fileName,
    sourcePath: pdf.absolutePath,
    modelId: options.embeddingModel,
    indexedAt: new Date().toISOString(),
    usage: chunkUsage,
    chunkIds: chunks.map((chunk) => chunk.id),
    embeddings: chunkEmbeddings,
  });

  return {
    artifactDir: relFromCache(cacheBaseDir, pdfDir),
    pages: pages.length,
    chunks: chunks.length,
  };
}

async function indexNote({ noteName, notePath, options, cacheBaseDir }) {
  const absolutePath = path.resolve(process.cwd(), notePath);
  const content = await readFile(absolutePath, "utf8");

  const chunks = buildChunksFromText({
    text: content,
    prefix: noteName,
    sourceName: path.basename(notePath),
    sourcePath: absolutePath,
  });

  const { embeddings, usage } = await embedValues({
    model: options.embeddingModel,
    values: chunks.map((chunk) => chunk.text),
  });

  const notesDir = path.join(cacheBaseDir, "notes", noteName);
  await ensureDir(notesDir);

  const chunksPath = path.join(notesDir, "chunks.json");
  const chunksEmbeddingPath = path.join(notesDir, "chunks.embedding.json");

  await writeJsonAtomic(chunksPath, {
    noteName,
    sourcePath: absolutePath,
    indexedAt: new Date().toISOString(),
    chunkingVersion: CHUNKING_VERSION,
    modelId: options.embeddingModel,
    chunks,
  });

  await writeJsonAtomic(chunksEmbeddingPath, {
    noteName,
    sourcePath: absolutePath,
    indexedAt: new Date().toISOString(),
    modelId: options.embeddingModel,
    usage,
    chunkIds: chunks.map((chunk) => chunk.id),
    embeddings,
  });

  return {
    artifactDir: relFromCache(cacheBaseDir, notesDir),
    chunks: chunks.length,
  };
}

function buildManifestEntryBase({ fingerprint, options, type }) {
  return {
    type,
    specialty: options.specialty,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    sha256: fingerprint.sha256,
    indexedAt: new Date().toISOString(),
    modelId: options.embeddingModel,
    chunkingVersion: CHUNKING_VERSION,
  };
}

async function main() {
  await loadDotEnvFiles();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  console.log(`[Index] Specialty: ${options.specialty}`);
  console.log(`[Index] Slides dir: ${options.slidesDir}`);
  console.log(`[Index] Cache dir: ${options.cacheDir}`);
  console.log(
    `[Index] Senior notes: ${options.seniorNotes.map((note) => `${note.id}=${note.path}`).join(", ")}`,
  );

  const mutoolAvailable = await commandExists("mutool", ["-v"]);
  if (!mutoolAvailable) {
    throw new Error("mutool is required but not found on PATH");
  }

  const tesseractAvailable = await commandExists("tesseract", ["--version"]);
  if (!tesseractAvailable && options.ocrPolicy !== "off") {
    console.warn("[OCR] tesseract not found on PATH. OCR fallback will be skipped.");
  }

  const { baseDir: cacheBaseDir, manifestPath } = resolveCachePaths(options.cacheDir);
  await ensureDir(cacheBaseDir);

  const manifest = await readManifest(manifestPath);
  manifest.chunkingVersion = CHUNKING_VERSION;
  manifest.embeddingModel = options.embeddingModel;

  const slides = await listSlidePdfs(options.slidesDir);

  const report = {
    pdf: { indexed: 0, skipped: 0, chunks: 0 },
    notes: { indexed: 0, skipped: 0, chunks: 0 },
  };

  for (const pdf of slides) {
    const fingerprint = await fingerprintFile(pdf.absolutePath);
    const existing = manifest.sources[pdf.absolutePath];

    const artifactDir = existing?.artifactDir
      ? absFromCache(cacheBaseDir, existing.artifactDir)
      : path.join(cacheBaseDir, "pdf", fingerprint.sha256);

    const artifactFiles = [
      path.join(artifactDir, "pages.json"),
      path.join(artifactDir, "summary.json"),
      path.join(artifactDir, "summary.embedding.json"),
      path.join(artifactDir, "chunks.json"),
      path.join(artifactDir, "chunks.embedding.json"),
    ];

    const fresh =
      !options.force &&
      existing &&
      existing.type === "pdf" &&
      existing.specialty === options.specialty &&
      existing.modelId === options.embeddingModel &&
      existing.chunkingVersion === CHUNKING_VERSION &&
      isFingerprintMatch(existing, fingerprint) &&
      (await hasAllArtifactFiles(artifactFiles));

    if (fresh) {
      report.pdf.skipped += 1;
      continue;
    }

    console.log(`[Index][PDF] ${pdf.fileName}`);
    const result = await indexPdf({
      pdf,
      fingerprint,
      options,
      cacheBaseDir,
      tesseractAvailable,
    });

    manifest.sources[pdf.absolutePath] = {
      ...buildManifestEntryBase({ fingerprint, options, type: "pdf" }),
      fileName: pdf.fileName,
      artifactDir: result.artifactDir,
    };

    report.pdf.indexed += 1;
    report.pdf.chunks += result.chunks;
  }

  for (const note of options.seniorNotes) {
    const noteName = note.id;
    const notePath = note.path;
    const absolutePath = path.resolve(process.cwd(), notePath);
    const fingerprint = await fingerprintFile(absolutePath);
    const existing = manifest.sources[absolutePath];

    const artifactDir = path.join(cacheBaseDir, "notes", noteName);
    const artifactFiles = [
      path.join(artifactDir, "chunks.json"),
      path.join(artifactDir, "chunks.embedding.json"),
    ];

    const fresh =
      !options.force &&
      existing &&
      existing.type === "note" &&
      existing.specialty === options.specialty &&
      existing.modelId === options.embeddingModel &&
      existing.chunkingVersion === CHUNKING_VERSION &&
      isFingerprintMatch(existing, fingerprint) &&
      (await hasAllArtifactFiles(artifactFiles));

    if (fresh) {
      report.notes.skipped += 1;
      continue;
    }

    console.log(`[Index][NOTE] ${noteName}`);
    const result = await indexNote({
      noteName,
      notePath,
      options,
      cacheBaseDir,
    });

    manifest.sources[absolutePath] = {
      ...buildManifestEntryBase({ fingerprint, options, type: "note" }),
      noteName,
      noteLabel: note.label,
      artifactDir: result.artifactDir,
    };

    report.notes.indexed += 1;
    report.notes.chunks += result.chunks;
  }

  await writeManifest(manifestPath, manifest);

  console.log("[Index] Completed");
  console.log(`  Specialty: ${options.specialty}`);
  console.log(`  PDFs indexed: ${report.pdf.indexed}`);
  console.log(`  PDFs skipped (cache hit): ${report.pdf.skipped}`);
  console.log(`  PDF chunks generated: ${report.pdf.chunks}`);
  console.log(`  Notes indexed: ${report.notes.indexed}`);
  console.log(`  Notes skipped (cache hit): ${report.notes.skipped}`);
  console.log(`  Note chunks generated: ${report.notes.chunks}`);
  console.log(`  Cache: ${cacheBaseDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
