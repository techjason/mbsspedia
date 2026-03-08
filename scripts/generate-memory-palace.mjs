#!/usr/bin/env node

import { gateway, generateText, Output } from "ai";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { z } from "zod";

const DOCS_ROOT = path.join(process.cwd(), "content", "docs");
const PUBLIC_ROOT = path.join(process.cwd(), "public", "memory-palaces");
const DEFAULT_IMAGE_MODEL = "google/gemini-3-pro-image";
const DEFAULT_TEXT_MODEL = "google/gemini-3-flash";
const FRONTMATTER_RE = /^---[\s\S]*?\n---\n?/;
const IMPORT_EXPORT_LINE_RE = /^\s*(import|export)\s.+$/gm;
const RESULT_PREVIEW_LIMIT = 24;
const KNOWN_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];

const BLUEPRINT_SCHEMA = z.object({
  sceneTitle: z.string().min(1),
  sceneSetting: z.string().min(1),
  anchors: z
    .array(
      z.object({
        number: z.number().int().min(1).max(20),
        scene: z.string().min(1),
        visualCue: z.string().min(1),
        medicalMeaning: z.string().min(1),
      }),
    )
    .min(8)
    .max(10),
});

const LEGEND_SCHEMA = z.object({
  rows: z.array(
    z.object({
      number: z.number().int().min(1).max(20),
      visualCue: z.string().min(1),
      meaning: z.string().min(1),
    }),
  ),
});

function printUsage() {
  console.log(`Usage:
  npm run generate:memory-palace -- [options]

Options:
  --article "<doc-stem>"       Use a specific article without interactive selection.
  --force                      Overwrite existing memory palace assets without prompting.
  --image-model "<provider/model>"
                               Image model. Default: ${DEFAULT_IMAGE_MODEL}
  --text-model "<provider/model>"
                               Text model. Default: ${DEFAULT_TEXT_MODEL}
  --help                       Show this help.

Examples:
  npm run generate:memory-palace
  npm run generate:memory-palace -- --article "general-surgery/lower-gi/acute-appendicitis"
  npm run generate:memory-palace -- --article "family-medicine/chest-pain" --force
`);
}

function parseArgs(argv) {
  const options = {
    article: undefined,
    force: false,
    imageModel: DEFAULT_IMAGE_MODEL,
    textModel: DEFAULT_TEXT_MODEL,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--article") {
      options.article = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--image-model") {
      options.imageModel = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }

    if (arg === "--text-model") {
      options.textModel = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
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

function stripDocExt(value) {
  return value.replace(/\.(md|mdx)$/i, "");
}

function normalizeDocStem(value) {
  return stripDocExt(String(value ?? ""))
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function humanizeFileName(fileName) {
  return fileName
    .replace(/\.(md|mdx)$/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function extractFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  return match ? match[0] : "";
}

function parseFrontmatterValue(frontmatter, key) {
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = frontmatter.match(pattern);
  if (!match) return "";

  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function cleanMdxText(raw) {
  return raw
    .replace(FRONTMATTER_RE, "")
    .replace(IMPORT_EXPORT_LINE_RE, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[(\d+)\]/g, " ")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function walkFiles(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const dirent of dirents) {
    const absolutePath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...(await walkFiles(absolutePath)));
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

async function scanArticles() {
  const files = await walkFiles(DOCS_ROOT);
  const articles = [];

  for (const absolutePath of files) {
    if (!absolutePath.endsWith(".mdx")) continue;
    if (path.basename(absolutePath).toLowerCase() === "index.mdx") continue;

    const relativePath = path.relative(DOCS_ROOT, absolutePath).replace(/\\/g, "/");
    const raw = await readFile(absolutePath, "utf8");
    const frontmatter = extractFrontmatter(raw);
    const title =
      parseFrontmatterValue(frontmatter, "title") ||
      humanizeFileName(path.basename(relativePath));
    const description = parseFrontmatterValue(frontmatter, "description");
    const docStem = normalizeDocStem(relativePath);

    articles.push({
      absolutePath,
      relativePath,
      docStem,
      title,
      description,
      searchText: normalizeSearchText(`${title} ${docStem}`),
    });
  }

  articles.sort(
    (a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
      a.docStem.localeCompare(b.docStem, undefined, { sensitivity: "base" }),
  );

  return articles;
}

function scoreArticle(article, filter) {
  if (!filter) return 1;
  const searchText = article.searchText;
  if (searchText === filter) return 6;
  if (searchText.startsWith(filter)) return 5;
  if (searchText.includes(filter)) return 4;
  const docStem = normalizeSearchText(article.docStem);
  if (docStem.startsWith(filter)) return 3;
  if (docStem.includes(filter)) return 2;
  return 0;
}

async function promptForArticleSelection(articles) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive article selection requires a TTY. Re-run with --article <doc-stem>.",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const rawFilter = await rl.question(
        `Filter articles (${articles.length} total, blank for all): `,
      );
      const filter = normalizeSearchText(rawFilter);
      const ranked = articles
        .map((article) => ({
          article,
          score: scoreArticle(article, filter),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.article.title.localeCompare(b.article.title, undefined, {
              sensitivity: "base",
            }),
        );

      if (ranked.length === 0) {
        console.log("No matching articles. Try another filter.");
        continue;
      }

      const visible = ranked.slice(0, RESULT_PREVIEW_LIMIT).map((entry) => entry.article);
      console.log("");
      visible.forEach((article, index) => {
        console.log(`${index + 1}. ${article.title} (${article.docStem})`);
      });
      if (ranked.length > visible.length) {
        console.log(
          `Showing the first ${visible.length} of ${ranked.length} matches. Narrow the filter to reduce the list.`,
        );
      }
      console.log("");

      const answer = await rl.question(
        `Select article [1-${visible.length}] or press Enter to refine: `,
      );
      const trimmed = answer.trim();
      if (!trimmed) {
        console.log("");
        continue;
      }

      const selectedIndex = Number.parseInt(trimmed, 10);
      if (
        !Number.isFinite(selectedIndex) ||
        selectedIndex < 1 ||
        selectedIndex > visible.length
      ) {
        console.log("Invalid selection. Enter one of the listed numbers.");
        console.log("");
        continue;
      }

      return visible[selectedIndex - 1];
    }
  } finally {
    rl.close();
  }
}

function resolveArticleByStem(articles, docStem) {
  const normalized = normalizeDocStem(docStem);
  const exactMatch = articles.find((article) => article.docStem === normalized);
  if (exactMatch) return exactMatch;

  const basenameMatches = articles.filter(
    (article) => path.posix.basename(article.docStem) === normalized,
  );

  if (basenameMatches.length === 1) {
    return basenameMatches[0];
  }

  if (basenameMatches.length > 1) {
    throw new Error(
      `Article stem "${docStem}" is ambiguous. Use the full doc stem, e.g. ${basenameMatches
        .map((article) => `"${article.docStem}"`)
        .join(", ")}.`,
    );
  }

  throw new Error(`Could not find article: ${docStem}`);
}

function resolveMemoryPalaceImportSpecifier(summaryImportSpecifier) {
  if (summaryImportSpecifier.endsWith("/summary.mdx")) {
    return summaryImportSpecifier.replace(/\/summary\.mdx$/, "/memory-palace.mdx");
  }

  return path.posix.join(
    path.posix.dirname(summaryImportSpecifier),
    "memory-palace.mdx",
  );
}

async function resolveSelectedArticle(article) {
  const docSource = await readFile(article.absolutePath, "utf8");
  const frontmatter = extractFrontmatter(docSource);
  const title =
    parseFrontmatterValue(frontmatter, "title") ||
    article.title ||
    humanizeFileName(path.basename(article.absolutePath));
  const description =
    parseFrontmatterValue(frontmatter, "description") || article.description || "";
  const summaryMatch = docSource.match(
    /^import\s+SummarySection\s+from\s+["']([^"']+)["'];?\s*$/m,
  );

  if (!summaryMatch) {
    throw new Error(
      `Selected article does not import SummarySection: ${article.docStem}`,
    );
  }

  const summaryImportSpecifier = summaryMatch[1];
  const summaryAbsPath = path.resolve(
    path.dirname(article.absolutePath),
    summaryImportSpecifier,
  );
  const summaryExists = await fileExists(summaryAbsPath);
  if (!summaryExists) {
    throw new Error(
      `Could not resolve summary fragment for ${article.docStem}: ${summaryAbsPath}`,
    );
  }

  const fragmentDir = path.dirname(summaryAbsPath);
  const memoryPalaceAbsPath = path.join(fragmentDir, "memory-palace.mdx");
  const memoryPalaceImportSpecifier = resolveMemoryPalaceImportSpecifier(
    summaryImportSpecifier,
  );
  const summaryRaw = await readFile(summaryAbsPath, "utf8");

  return {
    ...article,
    title,
    description,
    docSource,
    summaryAbsPath,
    summaryImportSpecifier,
    summaryText: cleanMdxText(summaryRaw),
    fragmentDir,
    memoryPalaceAbsPath,
    memoryPalaceImportSpecifier,
  };
}

function normalizeBlueprint(blueprint) {
  const anchors = [...blueprint.anchors].sort((a, b) => a.number - b.number);

  anchors.forEach((anchor, index) => {
    if (anchor.number !== index + 1) {
      throw new Error(
        `Blueprint numbering must be sequential starting at 1. Received ${anchor.number} at position ${index + 1}.`,
      );
    }
  });

  return {
    sceneTitle: blueprint.sceneTitle.trim(),
    sceneSetting: blueprint.sceneSetting.trim(),
    anchors: anchors.map((anchor) => ({
      number: anchor.number,
      scene: anchor.scene.trim(),
      visualCue: anchor.visualCue.trim(),
      medicalMeaning: anchor.medicalMeaning.trim(),
    })),
  };
}

function normalizeLegend(legend, anchorCount) {
  const rows = [...legend.rows].sort((a, b) => a.number - b.number);

  if (rows.length !== anchorCount) {
    throw new Error(
      `Legend row count ${rows.length} does not match blueprint anchor count ${anchorCount}.`,
    );
  }

  rows.forEach((row, index) => {
    if (row.number !== index + 1) {
      throw new Error(
        `Legend numbering must be sequential starting at 1. Received ${row.number} at position ${index + 1}.`,
      );
    }
  });

  return rows.map((row) => ({
    number: row.number,
    visualCue: row.visualCue.trim(),
    meaning: row.meaning.trim(),
  }));
}

async function generateBlueprint({ title, description, summaryText, textModel }) {
  const { output } = await generateText({
    model: gateway(textModel),
    output: Output.object({ schema: BLUEPRINT_SCHEMA }),
    system:
      "You design high-retention medical memory palaces. Produce a concrete, visually coherent scene plan that can be drawn as one sketch. Use clear, memorable loci in a stable left-to-right or top-to-bottom order.",
    prompt: `Create a numbered memory-palace blueprint for the following article.

Topic title: ${title}
Topic description: ${description || "N/A"}

Requirements:
- Produce exactly 8 to 10 numbered loci.
- Number the loci sequentially starting from 1.
- Each locus must be easy to sketch in a hand-drawn, sketchy educational style.
- Keep each medical meaning concise but exam-useful.
- Prefer concrete objects, places, gestures, and exaggerated visual metaphors over abstract concepts.
- Keep the whole scene visually coherent as one memory palace.

Article summary:
${summaryText}`,
  });

  return normalizeBlueprint(output);
}

function buildImagePrompt({ title, description, blueprint }) {
  const anchorLines = blueprint.anchors
    .map(
      (anchor) =>
        `${anchor.number}. Scene: ${anchor.scene}. Visual cue: ${anchor.visualCue}. Meaning: ${anchor.medicalMeaning}.`,
    )
    .join("\n");

  return `Create a sketchy-style medical memory palace illustration for the topic "${title}".

Topic description: ${description || "N/A"}
Overall scene title: ${blueprint.sceneTitle}
Overall scene setting: ${blueprint.sceneSetting}

Numbered loci to include exactly once each:
${anchorLines}

Visual requirements:
- Hand-drawn, sketchy, slightly whimsical study-sheet style.
- Clean composition with generous whitespace and uncluttered spacing.
- Landscape composition with a roughly 4:3 feel.
- Arabic numerals must be clearly visible next to each locus.
- Make the numbered cues readable at a glance.
- Use a light paper or notebook-page background.
- Keep it as one coherent memory palace, not a collage of unrelated panels.
- No legend table, no paragraph text, no citations, no reference list.
- Avoid dense prose labels; if text is used, keep it minimal and secondary to the drawing.
- Emphasize recognisable objects, spatial flow, and visual metaphors for recall.`;
}

async function generateLegendRows({ title, blueprint, textModel }) {
  const { output } = await generateText({
    model: gateway(textModel),
    output: Output.object({ schema: LEGEND_SCHEMA }),
    system:
      "You write concise numbered legends for medical memory palaces. Preserve numbering exactly and keep each row aligned to the supplied blueprint.",
    prompt: `Rewrite the following blueprint as legend rows for a memory-palace tab.

Topic title: ${title}

Rules:
- Return the same number of rows as the blueprint.
- Preserve numbering exactly.
- Keep visualCue short and concrete.
- Keep meaning concise and medically specific.
- Do not add new loci or merge rows.

Blueprint:
${JSON.stringify(blueprint, null, 2)}`,
  });

  return normalizeLegend(output, blueprint.anchors.length);
}

function extensionFromMediaType(mediaType) {
  const normalized = String(mediaType ?? "").trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  return "png";
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br />")
    .trim();
}

function buildMemoryPalaceFragment({ title, imagePublicPath, legendRows }) {
  const tableRows = legendRows
    .map(
      (row) =>
        `| ${row.number} | ${escapeTableCell(row.visualCue)} | ${escapeTableCell(
          row.meaning,
        )} |`,
    )
    .join("\n");

  return `![Sketchy memory palace for ${title}](${imagePublicPath})

_Sketchy memory palace for ${title}_

| No. | Visual Cue | Meaning |
| --- | --- | --- |
${tableRows}
`;
}

function ensureMemoryPalaceImport(docSource, importSpecifier) {
  if (/^import\s+MemoryPalaceSection\s+from\s+["'][^"']+["'];?\s*$/m.test(docSource)) {
    return docSource;
  }

  const summaryImportMatch = docSource.match(
    /^(import\s+SummarySection\s+from\s+["'][^"']+["'];?)\n+/m,
  );
  if (!summaryImportMatch) {
    throw new Error("Could not find SummarySection import to anchor Memory Palace import.");
  }

  const inserted = `${summaryImportMatch[1]}\nimport MemoryPalaceSection from ${JSON.stringify(
    importSpecifier,
  )};\n\n`;
  return docSource.replace(summaryImportMatch[0], inserted);
}

function ensureMemoryPalaceTabItem(docSource) {
  const tabsMatch = docSource.match(/<Tabs items=\{\[([\s\S]*?)\]\}>/);
  if (!tabsMatch) {
    throw new Error('Could not find `<Tabs items={[...]} >` block in article doc.');
  }

  const itemsSource = tabsMatch[1];
  if (itemsSource.includes('"Memory Palace"') || itemsSource.includes("'Memory Palace'")) {
    return docSource;
  }

  if (!itemsSource.includes('"Summary"') && !itemsSource.includes("'Summary'")) {
    throw new Error('Could not find "Summary" entry in tab items array.');
  }

  const updatedItemsSource = itemsSource.replace(
    /("Summary"|'Summary')/,
    '$1, "Memory Palace"',
  );

  return docSource.replace(
    tabsMatch[0],
    `<Tabs items={[${updatedItemsSource}]}>`,
  );
}

function ensureMemoryPalaceTabBlock(docSource) {
  if (/<Tab value="Memory Palace">/.test(docSource)) {
    return docSource;
  }

  const summaryTabMatch = docSource.match(/<Tab value="Summary">[\s\S]*?<\/Tab>/);
  if (!summaryTabMatch) {
    throw new Error('Could not find `<Tab value="Summary">` block in article doc.');
  }

  const memoryPalaceBlock = `<Tab value="Memory Palace">
  <MemoryPalaceSection components={props.components} />

</Tab>`;

  return docSource.replace(
    summaryTabMatch[0],
    `${summaryTabMatch[0]}\n\n${memoryPalaceBlock}`,
  );
}

async function findExistingImageAssets(docStem) {
  const matches = [];

  for (const extension of KNOWN_IMAGE_EXTENSIONS) {
    const absolutePath = path.join(PUBLIC_ROOT, `${docStem}.${extension}`);
    if (await fileExists(absolutePath)) {
      matches.push(absolutePath);
    }
  }

  return matches;
}

async function confirmOverwriteIfNeeded({ selectedArticle, force }) {
  const existingImageAssets = await findExistingImageAssets(selectedArticle.docStem);
  const fragmentExists = await fileExists(selectedArticle.memoryPalaceAbsPath);
  const needsOverwrite = fragmentExists || existingImageAssets.length > 0;

  if (!needsOverwrite) {
    return { fragmentExists, existingImageAssets };
  }

  if (force) {
    return { fragmentExists, existingImageAssets };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Memory palace assets already exist for ${selectedArticle.docStem}. Re-run with --force to overwrite.`,
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `Memory palace assets already exist for ${selectedArticle.docStem}. Overwrite? [y/N] `,
    );
    const confirmed = /^y(es)?$/i.test(answer.trim());
    if (!confirmed) {
      throw new Error("Aborted without overwriting existing memory palace assets.");
    }
  } finally {
    rl.close();
  }

  return { fragmentExists, existingImageAssets };
}

async function removeExistingImageAssets(pathsToDelete, keepPath) {
  for (const existingPath of pathsToDelete) {
    if (keepPath && path.resolve(existingPath) === path.resolve(keepPath)) {
      continue;
    }

    await unlink(existingPath);
  }
}

async function main() {
  await loadDotEnvFiles();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error("AI_GATEWAY_API_KEY is required in .env.local or .env.");
  }

  const articles = await scanArticles();
  if (articles.length === 0) {
    throw new Error("No article docs were found under content/docs.");
  }

  const selectedArticleBase = options.article
    ? resolveArticleByStem(articles, options.article)
    : await promptForArticleSelection(articles);

  const selectedArticle = await resolveSelectedArticle(selectedArticleBase);
  const { existingImageAssets } = await confirmOverwriteIfNeeded({
    selectedArticle,
    force: options.force,
  });

  console.log(`[memory-palace] Selected article: ${selectedArticle.title} (${selectedArticle.docStem})`);
  console.log(`[memory-palace] Generating blueprint with ${options.textModel}...`);
  const blueprint = await generateBlueprint({
    title: selectedArticle.title,
    description: selectedArticle.description,
    summaryText: selectedArticle.summaryText,
    textModel: options.textModel,
  });

  console.log(`[memory-palace] Generating image with ${options.imageModel}...`);
  const imageResult = await generateText({
    model: gateway(options.imageModel),
    prompt: buildImagePrompt({
      title: selectedArticle.title,
      description: selectedArticle.description,
      blueprint,
    }),
  });

  const imageFiles = (imageResult.files ?? []).filter((file) =>
    file.mediaType?.startsWith("image/"),
  );
  const image = imageFiles[0];
  if (!image) {
    throw new Error("Image model returned no image.");
  }

  const imageExtension = extensionFromMediaType(image.mediaType);
  const imageAbsolutePath = path.join(
    PUBLIC_ROOT,
    `${selectedArticle.docStem}.${imageExtension}`,
  );
  const imagePublicPath = `/memory-palaces/${selectedArticle.docStem}.${imageExtension}`.replace(
    /\\/g,
    "/",
  );

  console.log(`[memory-palace] Generating legend rows with ${options.textModel}...`);
  const legendRows = await generateLegendRows({
    title: selectedArticle.title,
    blueprint,
    textModel: options.textModel,
  });

  const fragmentSource = buildMemoryPalaceFragment({
    title: selectedArticle.title,
    imagePublicPath,
    legendRows,
  });

  const updatedDocSource = [
    (source) =>
      ensureMemoryPalaceImport(source, selectedArticle.memoryPalaceImportSpecifier),
    ensureMemoryPalaceTabItem,
    ensureMemoryPalaceTabBlock,
  ].reduce((source, transform) => transform(source), selectedArticle.docSource);

  await mkdir(path.dirname(imageAbsolutePath), { recursive: true });
  await mkdir(selectedArticle.fragmentDir, { recursive: true });
  await writeFile(imageAbsolutePath, image.uint8Array);
  await removeExistingImageAssets(existingImageAssets, imageAbsolutePath);
  await writeFile(selectedArticle.memoryPalaceAbsPath, fragmentSource, "utf8");
  await writeFile(selectedArticle.absolutePath, updatedDocSource, "utf8");

  console.log(`[memory-palace] Wrote image: ${imageAbsolutePath}`);
  console.log(`[memory-palace] Wrote fragment: ${selectedArticle.memoryPalaceAbsPath}`);
  console.log(`[memory-palace] Updated article: ${selectedArticle.absolutePath}`);
}

main().catch((error) => {
  console.error("[memory-palace] Failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
