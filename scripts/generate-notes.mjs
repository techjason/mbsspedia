#!/usr/bin/env node

import {
  APICallError,
  Output,
  gateway,
  generateText,
  jsonSchema,
  wrapLanguageModel,
} from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseEnv, promisify } from "node:util";
import {
  CHUNKING_VERSION as INDEX_CHUNKING_VERSION,
  buildChunksFromText as buildChunksFromTextShared,
  buildTopicTerms as buildTopicTermsShared,
  lexicalScore as lexicalScoreShared,
  previewText as previewTextShared,
} from "./lib/rag-chunking.mjs";
import {
  absFromCache,
  readJsonIfExists,
  readManifest,
  resolveCachePaths,
} from "./lib/rag-cache.mjs";
import { DEFAULT_EMBEDDING_MODEL, embedSingleValue } from "./lib/rag-embed.mjs";
import {
  assembleSectionContext,
  buildSectionQuery,
  mergeSourceBalanced,
  rankChunksHybrid,
  rankSlideFilesByHybrid,
} from "./lib/rag-retrieval.mjs";

const execFileAsync = promisify(execFile);

const TOPIC_CITATION_RULES = `Citation and references rules (strict):
- Use inline numeric citations in plain text only: [1], [2], [3], etc.
- Do NOT use URL links for citations unless explicitly provided.
- Cite only approved source label styles:
  - Lecture slides: <slide file name> (optional page/section)
  - Senior notes: <note file name> (optional chapter/section)
- Keep citation numbering consistent across the full topic (Etiology -> DDx -> Dx -> Mx -> Complications). Reuse the same number when the same source is cited again in later sections.
- Include exactly one "## References" block in EACH section after the <ActiveRecallQuiz /> block.
- In that section's references block, list only sources cited in that section using numbered lines:
  [1] Lecture slides: ...
  [2] Senior notes: ...
- Do not include uncited references.
`;

const FOLLOW_UP_CITATION_RULES =
  'Use inline [n] citations and include exactly one "## References" block after <ActiveRecallQuiz />. Keep numbering consistent with prior sections; for the same source reuse the same number. References must use source names only (Lecture slides: <file>; Senior notes: <file>) and include only citations used in this section.';

const PROMPT_1_TEMPLATE = `You are a dedicated note-curation AI agent specialized in medical topics to prepare for HKUMed Clinical Medical School Summative exams for a medical student. Your task is to curate comprehensive notes on a user-supplied medical [condition] in a strict, dedicated format. Ensure the content is extremely comprehensive, systematic, and fills in any gaps. Use markdown for formatting (e.g., headings, bullet points, table and callouts) within sections for clarity. You will be given sample notes for that condition. Sample notes file name: [{{sampleNotesFileName}}]

Make sure to use it as reference and write/generate on top of it. (Please note that the reference sample notes might be outdated (2016 to 2020) so use the latest guidelines/approach right now in 2026 instead if it has changed)

Generate an extremely comprehensive, systematic notes of the [condition] not missing ANY small details. Elaborate and fill in the gaps. Provide the clinical approach to [condition], starting with definition, epidemiology and risk factors, anatomy and function, relevant etiology (focus on Hong Kong) and its respective pathophysiology, relevant classification, Clinical features separate by symptoms and signs with their inline pathophysiological basis (everything before ddx, diagnosis, management and complications) in the following response. I will ask for the differential diagnosis, diagnostic criteria, algorithm and management of [condition] and complications later on. Extremely comprehensive, systematic summary, not missing ANY small details. Elaborate and fill in the gaps. Focus on explanation to aid in understanding every single tiny concept over rote memorization. Make sure to explain "why" for concepts and explain everything from first principles.

If given powerpoint slides - treat these as high yield study points.  Bold and italicise points that are mentioned from the lecture slides.  Do not miss any important information or details from the lecture slide in the generated notes - make sure to bold and italicise them.

Powerpoint attachment file name: [{{powerpointFileNames}}]

Tone: Down-to-earth, logical, slightly conversational, and authoritative. Talk like a senior doctor teaching on a ward round.

Formatting:
- Never list a symptom or treatment without explaining the mechanism.
- Bold and italicize points mentioned on lecture slides. Do not miss any detail on the lecture slides.
- Connect clinical features back to the pathophysiology (e.g., "Why does Right Heart Failure cause ascites? Because of hydrostatic back-pressure in the hepatic veins").
- Break down complex drug names or medical terms into Latin/Greek roots to explain what they do (e.g., Neuromyelitis optica (NMO) → "neuro" = nerve, "myelitis" = spinal cord inflammation, "optica" = optic; BPPV → "benign" = not dangerous, "paroxysmal" = sudden attacks, "positional" = triggered by head position, "vertigo" = spinning; the name tells you the condition).
- Explicitly highlight high yield points, important must know information for exams and lecture slides material using markdown block quotes. Always include a final high yield summary at the end in <Callout title="High Yield Summary"></Callout> as well.
- After the summary at the end, include high yield exam active recall questions (along with concise answer scheme) for me to practice active recall.
- The <ActiveRecallQuiz /> block must use this exact prop shape:
  <ActiveRecallQuiz
    title="Active Recall - <Section Name>"
    items={[
      {
        question: "Question text",
        markscheme: "Concise answer scheme for grading.",
      },
    ]}
  />
- Include 3 to 6 high-yield questions in items. 
- Keep question and markscheme values as plain double-quoted strings that compile in MDX/JSX (no markdown headings inside strings, no code fences).
- Include important and widely used mnemonics when needed
- Mermaid syntax rule (for any diagrams): never put parentheses in an unquoted node label. Use quoted labels like A["Upper Endoscopy (OGD)"] whenever a label contains parentheses, <, >, or HTML tags.
- In prose (e.g. "value > 5", "pH < 7"): always put a space after < and after > so the MDX parser does not treat them as JSX tags (write "> 5" and "< 7", not ">5" or "<7").
- Do not include document-banner headings/subheadings such as "Comprehensive Notes on ...", "... - Part X", or any standalone "Part 1/2/3" line. Start directly with section content.
${TOPIC_CITATION_RULES}

Examples of Callouts:

<Callout title="Title">Callout used to convey an important concept/message</Callout>

<Callout title="Title" type="error">
 Callout used to convey a usual mistake that medical students tend to make or overlook
</Callout>

<Callout title="Title" type="idea">
  Callout used to convey an idea or suggestion
</Callout>

Condition: [{{condition}}]`;

const FOLLOW_UP_PROMPTS = [
  `Proceed to differential diagnosis. (Remember to explain why for concepts and explain from first principles. Bold and italicise points mentioned on lecture slides. Include a mermaid diagram. Mermaid rule: never put parentheses in an unquoted node label. Use quoted labels like A["Upper Endoscopy (OGD)"] for any label containing parentheses, <, >, or HTML tags. Do not add document-banner headings or any Part X title. Include exactly one <ActiveRecallQuiz /> block using items[{ question, markscheme }], then include a "## References" block after it. ${FOLLOW_UP_CITATION_RULES})`,
  `Proceed to diagnostic criteria, diagnostic algorithm (with mermaid diagram) and investigation modalities with key findings and interpretations. (Remember to explain why for concepts and explain from first principles. Bold and italicise points mentioned on lecture slides. Mermaid rule: never put parentheses in an unquoted node label. Use quoted labels like A["Upper Endoscopy (OGD)"] for any label containing parentheses, <, >, or HTML tags. Do not add document-banner headings or any Part X title. Include exactly one <ActiveRecallQuiz /> block using items[{ question, markscheme }], then include a "## References" block after it. ${FOLLOW_UP_CITATION_RULES})`,
  `Proceed to management algorithm (with mermaid diagram) and treatment modalities with indications and contraindications. (Remember to explain why for concepts and explain from first principles. Bold and italicise points mentioned on lecture slides. Mermaid rule: never put parentheses in an unquoted node label. Use quoted labels like A["Upper Endoscopy (OGD)"] for any label containing parentheses, <, >, or HTML tags. Do not add document-banner headings or any Part X title. Include exactly one <ActiveRecallQuiz /> block using items[{ question, markscheme }], then include a "## References" block after it. ${FOLLOW_UP_CITATION_RULES})`,
  `Finally, proceed to common complications. (Remember to explain why for concepts and explain from first principles. Also bold and italicise points mentioned on lecture slides. Do not add document-banner headings or any Part X title. Include exactly one <ActiveRecallQuiz /> block using items[{ question, markscheme }], then include a "## References" block after it. ${FOLLOW_UP_CITATION_RULES})`,
];

const DEFAULT_SECTION_PLAN = [
  { fileName: "etiology", tabName: "Etiology" },
  { fileName: "ddx", tabName: "DDx" },
  { fileName: "dx", tabName: "Dx" },
  { fileName: "mx", tabName: "Mx" },
  { fileName: "complications", tabName: "Complications" },
];

const HISTORY_TAKING_PROMPT_TEMPLATE = `You are a dedicated medical note-curation AI agent preparing HKUMed Clinical Medical School OSCEs.

Task: Generate one-shot, comprehensive "history taking" notes for the chief complaint [{{condition}}].

You are given sample notes file name(s): [{{sampleNotesFileName}}]
Powerpoint attachment file name(s): [{{powerpointFileNames}}]

Deliver a complete history-taking guide in ONE response only (no follow-up sections). Cover:
- Focused presenting complaint framework and symptom analysis (onset, timing, progression, severity, red flags).
- Targeted systems review relevant to this condition.
- Risk factors, exposure history, comorbidities, medications, allergy history, family history, social history, and functional baseline.
- This will be done in Hong Kong, so include relevant Cantonese translations that will be used in the OSCE Viva.
- Focused differentiating questions that help distinguish important alternatives.
- Red-flag findings and escalation triggers.
- Common pitfalls in history-taking for this condition.
- High-yield exam-focused interpretation tips ("why this question matters").
- Include a model reporting script to a clinician/surgeon. This should follow the British framework of chief complaint, HPI, PMHx, Past Surgical History, Medication and Allergies, Family History, Social History and a summary. NO NEED to include physical exam results. Example: "Mr Chan is a 50-year-old gentleman who presented 7 days ago to QMH with ...". 

Tone: Down-to-earth, logical, slightly conversational, and authoritative, like a senior doctor teaching on a ward round.

Formatting rules:
- Explain why each key history question is asked, not just what to ask.
- Use markdown headings and bullet points.
- Include practical phrasing examples for key questions when useful.
- Bold and italicize points mentioned on lecture slides.
- Include a master mermaid diagram of the history taking framework.
- Include one final <Callout title="High Yield Summary"></Callout>.
- Include exactly one <ActiveRecallQuiz /> block using this exact shape:
  <ActiveRecallQuiz
    title="Active Recall - History Taking"
    items={[
      {
        question: "Question text commonly asked during OSCE Viva",
        markscheme: "Concise answer used for OSCE Viva",
      },
    ]}
  />
- Include 3 to 6 high-yield questions that will be asked in the OSCE Viva in items.
- Keep question and markscheme values as plain double-quoted strings that compile in MDX/JSX.
- Do not add document-banner headings/subheadings such as "Comprehensive Notes on ...", "... - Part X", or any standalone "Part 1/2/3" line.
${TOPIC_CITATION_RULES}

Examples of Callouts:

<Callout title="Title">Callout used to convey an important concept/message</Callout>

<Callout title="Title" type="error">
 Callout used to convey a usual mistake that medical students tend to make or overlook
</Callout>

<Callout title="Title" type="idea">
  Callout used to convey an idea or suggestion
</Callout>

Chief Complaint: [{{condition}}]`;

const PROMPT_PROFILES = {
  default: {
    template: PROMPT_1_TEMPLATE,
    oneShotSection: { fileName: "etiology", tabName: "Etiology" },
  },
  "history-taking": {
    template: HISTORY_TAKING_PROMPT_TEMPLATE,
    oneShotSection: { fileName: "history-taking", tabName: "History Taking" },
  },
};

const DEFAULT_SPECIALTY = "general-surgery";
const SURGERY_SAMPLE_NOTE_PATH = "scripts/SeniorNotes/felixlai.md";
const SURGERY_SECONDARY_NOTE_PATH = "scripts/SeniorNotes/maxim.md";
const DEFAULT_PSYCHIATRY_SLIDES_DIR = "/Users/jason/Documents/PyschiatrySlides";
const DEFAULT_FAMILY_MEDICINE_SPECIALTY = "family-medicine";
const DEFAULT_FAMILY_MEDICINE_SOURCES_DIR =
  "/Users/jason/Documents/FamilyMedicineSources";
const DEFAULT_SENIOR_NOTES = [
  { id: "felix", path: SURGERY_SAMPLE_NOTE_PATH, label: "Felix Lai" },
  { id: "maxim", path: SURGERY_SECONDARY_NOTE_PATH, label: "Maxim" },
];
const DEFAULT_PSYCHIATRY_SENIOR_NOTES = [
  {
    id: "ryanho-psych",
    path: "scripts/ryanho-psych.md",
    label: "Ryan Ho (Psychiatry)",
  },
];
const DEFAULT_SLIDES_DIR = "/Users/jason/Documents/BlockBSlides";
const DEFAULT_SURGERY_SENIOR_NOTES_DIR = "scripts/SeniorNotes";
const DEFAULT_FAMILY_MEDICINE_SENIOR_NOTES_DIRS = [
  DEFAULT_FAMILY_MEDICINE_SOURCES_DIR,
  DEFAULT_SURGERY_SENIOR_NOTES_DIR,
];
const DEFAULT_CACHE_ROOT = ".cache/rag";
const DEFAULT_SURGERY_CACHE_DIR = `${DEFAULT_CACHE_ROOT}/surgery`;

const SCOUT_CANDIDATE_LIMIT = envInt("RAG_SCOUT_CANDIDATE_LIMIT", 120);
const SCOUT_SELECTION_LIMIT = envInt("RAG_SCOUT_SELECTION_LIMIT", 28);
const DEFAULT_TOP_SLIDES = 4;
const MAX_SLIDE_PAGE_CHUNKS = envInt("RAG_MAX_SLIDE_PAGE_CHUNKS", 20);
const LEGACY_SLIDE_PAGES_PER_FILE = 3;
const CONTEXT_CHAR_BUDGET = 120000;
const SECTION_CONTEXT_CHAR_BUDGET = envInt(
  "RAG_SECTION_CONTEXT_CHAR_BUDGET",
  78000,
);
const SECTION_PER_SOURCE_RANK_LIMIT = envInt(
  "RAG_SECTION_PER_SOURCE_RANK_LIMIT",
  80,
);
const SECTION_MERGE_PER_SOURCE_CAP = envInt(
  "RAG_SECTION_MERGE_PER_SOURCE_CAP",
  32,
);
const SECTION_MERGE_CANDIDATE_LIMIT = envInt(
  "RAG_SECTION_MERGE_CANDIDATE_LIMIT",
  144,
);
const ERROR_CHAIN_LIMIT = 8;
const LOG_VALUE_PREVIEW_CHARS = 3000;
const LOG_OBJECT_KEY_LIMIT = 30;
const LOG_ARRAY_ITEM_LIMIT = 10;

const CHUNK_SELECTION_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    selectedChunkIds: {
      type: "array",
      items: { type: "string" },
      description: "Chunk IDs chosen for relevance.",
    },
    rationale: {
      type: "string",
      description: "Very short rationale for selection.",
    },
  },
  required: ["selectedChunkIds", "rationale"],
  additionalProperties: false,
});

const SLIDE_SELECTION_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    selectedFileNames: {
      type: "array",
      items: { type: "string" },
      description: "Slide PDF file names chosen for relevance.",
    },
    rationale: {
      type: "string",
      description: "Very short rationale for selection.",
    },
  },
  required: ["selectedFileNames", "rationale"],
  additionalProperties: false,
});

function printUsage() {
  console.log(`Usage:
  npm run generate:notes -- [options] <topic> [more-topics]

Options:
  --topics "<topic1,topic2>"   Comma-separated topics.
  -surgery, --surgery          Use surgery preset defaults.
  -psychiatry, --psychiatry    Shortcut preset:
                               specialty=psychiatry
                               slides-dir=${DEFAULT_PSYCHIATRY_SLIDES_DIR}
                               senior-note=${DEFAULT_PSYCHIATRY_SENIOR_NOTES[0].path}
  -family-medicine, --family-medicine, --family
                               Shortcut preset:
                               specialty=${DEFAULT_FAMILY_MEDICINE_SPECIALTY}
                               slides-dir=${DEFAULT_FAMILY_MEDICINE_SOURCES_DIR}
                               senior-notes-dir=${DEFAULT_FAMILY_MEDICINE_SOURCES_DIR}
                               senior-notes-dir=${DEFAULT_SURGERY_SENIOR_NOTES_DIR}
  --model "<provider/model>"   Generation model. Default: anthropic/claude-opus-4.6
  --selection-model "<provider/model>" Selection model for scouts/slides. Default: anthropic/claude-opus-4.6
  --specialty "<folder-name>"  Default: ${DEFAULT_SPECIALTY}
  --senior-note "<path>"       Add a senior note source (repeatable). Format: "<label>=<path>" or "<path>".
  --senior-notes-dir "<path>"  Add every .md/.mdx/.txt/.pdf file in directory as senior notes (repeatable).
  --felix-note "<path>"        Backward-compatible alias for senior note slot #1.
  --maxim-note "<path>"        Backward-compatible alias for senior note slot #2.
  --slides-dir "<path>"         Default: /Users/jason/Documents/BlockBSlides
  --top-slides <n>              Number of slide PDFs to select. Default: ${DEFAULT_TOP_SLIDES}
  --topic-concurrency <n>       Number of topics to generate in parallel. Default: 2
  --cache-dir "<path>"          Retrieval cache directory. Default: ${DEFAULT_SURGERY_CACHE_DIR}
  --allow-stale-index           Continue with stale/missing index artifacts (warn only).
  --no-context-scouts           Disable retrieval pipeline and use legacy direct context injection.
  --sample-note "<path>"        Legacy sample notes file (used with --no-context-scouts).
  --slides "<path>"             Legacy slides text file (used with --no-context-scouts).
  --prompt-profile "<profile>"  Prompt preset: default | history-taking. Default: default
  --history-taking              Shortcut for --prompt-profile "history-taking" --one-shot
  --prompt-file "<path>"        Custom initial prompt template file (supports {{condition}}, {{sampleNotesFileName}}, {{powerpointFileNames}}).
  --one-shot                    Generate only one section (skip follow-up prompts).
  --devtools                    Enable AI SDK DevTools middleware (default: enabled).
  --no-devtools                 Disable AI SDK DevTools middleware for this run.
  --help                        Show this help.

Examples:
  npm run generate:notes -- "acute pancreatitis"
  npm run generate:notes -- --topic-concurrency 3 "acute pancreatitis" "appendicitis"
  npm run generate:notes -- --selection-model "anthropic/claude-opus-4.6" --top-slides 5 "acute pancreatitis"
  npm run generate:notes -- --senior-notes-dir "scripts/SeniorNotes" --history-taking "lower gi bleed"
  npm run generate:notes -- --psychiatry "major depressive disorder"
  npm run generate:notes -- --family-medicine "hypertension"
  npm run generate:notes -- --specialty psychiatry --senior-note "/path/to/psychiatry-senior.md" --slides-dir "/path/to/psychiatry/slides" "major depressive disorder"
  npm run generate:notes -- --history-taking "chest pain"
`);
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
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
    label ||
    path.basename(notePath, path.extname(notePath)) ||
    `note-${fallbackIndex + 1}`;
  const id = slugify(fallbackLabel) || `note-${fallbackIndex + 1}`;
  return { id, path: notePath, label: fallbackLabel };
}

function isPdfFilePath(filePath) {
  return path.extname(String(filePath ?? "")).toLowerCase() === ".pdf";
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

function upsertSeniorNoteByPath(notes, entry) {
  const next = Array.isArray(notes) ? notes.slice() : [];
  const absolutePath = path.resolve(process.cwd(), entry.path);
  const existingIndex = next.findIndex(
    (note) => path.resolve(process.cwd(), note.path) === absolutePath,
  );

  if (existingIndex >= 0) {
    next[existingIndex] = entry;
    return next;
  }

  return upsertSeniorNote(next, entry);
}

function parseArgs(argv) {
  const options = {
    model: "anthropic/claude-opus-4.6",
    selectionModel: "anthropic/claude-opus-4.6",
    specialty: DEFAULT_SPECIALTY,
    contextScouts: true,
    sampleNotePath: SURGERY_SAMPLE_NOTE_PATH,
    slidesPath: undefined,
    seniorNotes: DEFAULT_SENIOR_NOTES.slice(),
    seniorNotesDirs: [DEFAULT_SURGERY_SENIOR_NOTES_DIR],
    seniorNotesExplicit: false,
    slidesDir: DEFAULT_SLIDES_DIR,
    slidesDirExplicit: false,
    topSlides: DEFAULT_TOP_SLIDES,
    topicConcurrency: 2,
    cacheDir: DEFAULT_SURGERY_CACHE_DIR,
    cacheDirExplicit: false,
    allowStaleIndex: false,
    promptProfile: "default",
    promptFilePath: undefined,
    oneShot: false,
    devtools: true,
    topics: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--model") {
      options.model = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--selection-model") {
      options.selectionModel = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--specialty") {
      options.specialty = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "-surgery" || arg === "--surgery") {
      options.specialty = DEFAULT_SPECIALTY;
      options.sampleNotePath = SURGERY_SAMPLE_NOTE_PATH;
      options.seniorNotes = DEFAULT_SENIOR_NOTES.slice();
      options.seniorNotesDirs = [DEFAULT_SURGERY_SENIOR_NOTES_DIR];
      options.seniorNotesExplicit = false;
      options.slidesDir = DEFAULT_SLIDES_DIR;
      options.slidesDirExplicit = false;
      continue;
    }

    if (arg === "-psychiatry" || arg === "--psychiatry") {
      options.specialty = "psychiatry";
      options.seniorNotes = DEFAULT_PSYCHIATRY_SENIOR_NOTES.slice();
      options.seniorNotesDirs = [];
      options.seniorNotesExplicit = false;
      options.slidesDir = DEFAULT_PSYCHIATRY_SLIDES_DIR;
      options.slidesDirExplicit = false;
      continue;
    }

    if (
      arg === "-family-medicine" ||
      arg === "--family-medicine" ||
      arg === "--family"
    ) {
      const maybeFamilySuffix = String(argv[i + 1] ?? "")
        .trim()
        .toLowerCase();
      if (arg === "--family" && maybeFamilySuffix === "medicine") {
        i += 1;
      }
      options.specialty = DEFAULT_FAMILY_MEDICINE_SPECIALTY;
      options.seniorNotes = [];
      options.seniorNotesDirs = DEFAULT_FAMILY_MEDICINE_SENIOR_NOTES_DIRS.slice();
      options.seniorNotesExplicit = true;
      options.slidesDir = DEFAULT_FAMILY_MEDICINE_SOURCES_DIR;
      options.slidesDirExplicit = false;
      continue;
    }

    if (arg === "--no-context-scouts") {
      options.contextScouts = false;
      continue;
    }

    if (arg === "--sample-note") {
      options.sampleNotePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--slides") {
      options.slidesPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--senior-note") {
      if (!options.seniorNotesExplicit) {
        options.seniorNotes = [];
        options.seniorNotesDirs = [];
        options.seniorNotesExplicit = true;
      }
      const note = parseSeniorNoteSpec(argv[i + 1], options.seniorNotes.length);
      options.seniorNotes = upsertSeniorNote(options.seniorNotes, note);
      i += 1;
      continue;
    }

    if (arg === "--senior-notes-dir") {
      const rawDir = String(argv[i + 1] ?? "").trim();
      if (!rawDir) {
        throw new Error("--senior-notes-dir requires a directory path");
      }
      if (!options.seniorNotesExplicit) {
        options.seniorNotes = [];
        options.seniorNotesDirs = [];
        options.seniorNotesExplicit = true;
      }
      options.seniorNotesDirs.push(rawDir);
      i += 1;
      continue;
    }

    if (arg === "--felix-note") {
      if (!options.seniorNotesExplicit) {
        options.seniorNotes = [];
        options.seniorNotesDirs = [];
      }
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
      if (!options.seniorNotesExplicit) {
        options.seniorNotes = [];
        options.seniorNotesDirs = [];
      }
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

    if (arg === "--top-slides") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--top-slides must be an integer >= 1");
      }
      options.topSlides = value;
      i += 1;
      continue;
    }

    if (arg === "--topic-concurrency") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--topic-concurrency must be an integer >= 1");
      }
      options.topicConcurrency = value;
      i += 1;
      continue;
    }

    if (arg === "--cache-dir") {
      options.cacheDir = argv[i + 1];
      options.cacheDirExplicit = true;
      i += 1;
      continue;
    }

    if (arg === "--allow-stale-index") {
      options.allowStaleIndex = true;
      continue;
    }

    if (arg === "--prompt-profile") {
      options.promptProfile = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--history-taking") {
      options.promptProfile = "history-taking";
      options.oneShot = true;
      continue;
    }

    if (arg === "--prompt-file") {
      options.promptFilePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--one-shot") {
      options.oneShot = true;
      continue;
    }

    if (arg === "--devtools") {
      options.devtools = true;
      continue;
    }

    if (arg === "--no-devtools") {
      options.devtools = false;
      continue;
    }

    if (arg === "--topics") {
      const value = argv[i + 1];
      i += 1;
      const parsedTopics = value
        .split(",")
        .map((topic) => topic.trim())
        .filter(Boolean);
      options.topics.push(...parsedTopics);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    options.topics.push(arg.trim());
  }

  options.topics = Array.from(new Set(options.topics.filter(Boolean)));

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
      options.seniorNotesDirs = [];
    }
    if (!options.slidesDirExplicit) {
      options.slidesDir = DEFAULT_PSYCHIATRY_SLIDES_DIR;
    }
  }

  if (normalizedSpecialty === DEFAULT_FAMILY_MEDICINE_SPECIALTY) {
    if (!options.seniorNotesExplicit) {
      options.seniorNotes = [];
      options.seniorNotesDirs = DEFAULT_FAMILY_MEDICINE_SENIOR_NOTES_DIRS.slice();
      options.seniorNotesExplicit = true;
    }
    if (!options.slidesDirExplicit) {
      options.slidesDir = DEFAULT_FAMILY_MEDICINE_SOURCES_DIR;
    }
  }

  if (options.seniorNotes.length === 0 && options.seniorNotesDirs.length === 0) {
    throw new Error(
      "At least one senior note is required. Use --senior-note or --senior-notes-dir.",
    );
  }

  const hasBuiltInPresetDefaults =
    normalizedSpecialty === "psychiatry" ||
    normalizedSpecialty === DEFAULT_FAMILY_MEDICINE_SPECIALTY;

  if (normalizedSpecialty !== DEFAULT_SPECIALTY) {
    if (!hasBuiltInPresetDefaults && !options.seniorNotesExplicit) {
      throw new Error(
        `Specialty "${normalizedSpecialty}" requires explicit senior notes. Use --senior-note "<path>".`,
      );
    }
    if (!hasBuiltInPresetDefaults && !options.slidesDirExplicit) {
      throw new Error(
        `Specialty "${normalizedSpecialty}" requires an explicit slides directory. Use --slides-dir "<path>".`,
      );
    }
  }

  const normalizedPromptProfile = slugify(options.promptProfile) || "default";
  if (!(normalizedPromptProfile in PROMPT_PROFILES)) {
    throw new Error(
      `Unknown prompt profile: "${options.promptProfile}". Valid profiles: ${Object.keys(PROMPT_PROFILES).join(", ")}`,
    );
  }
  options.promptProfile = normalizedPromptProfile;

  if (options.promptProfile === "history-taking") {
    options.oneShot = true;
  }

  return options;
}

function buildLanguageModel(modelId, useDevTools) {
  const baseModel = gateway(modelId);
  if (!useDevTools) {
    return baseModel;
  }

  return wrapLanguageModel({
    model: baseModel,
    middleware: devToolsMiddleware(),
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function truncateForLogs(value, maxChars = LOG_VALUE_PREVIEW_CHARS) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= maxChars) {
    return value;
  }

  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function sanitizeForLogs(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateForLogs(value);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (depth >= 3) {
    if (Array.isArray(value)) {
      return `[Array(${value.length})]`;
    }

    return "[Object]";
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, LOG_ARRAY_ITEM_LIMIT)
      .map((item) => sanitizeForLogs(item, depth + 1));
    if (value.length > LOG_ARRAY_ITEM_LIMIT) {
      items.push(`[+${value.length - LOG_ARRAY_ITEM_LIMIT} more items]`);
    }
    return items;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (!isRecord(value)) {
    return String(value);
  }

  const entries = Object.entries(value);
  const sanitized = {};
  for (const [key, item] of entries.slice(0, LOG_OBJECT_KEY_LIMIT)) {
    sanitized[key] = sanitizeForLogs(item, depth + 1);
  }
  if (entries.length > LOG_OBJECT_KEY_LIMIT) {
    sanitized.__truncatedKeys = entries.length - LOG_OBJECT_KEY_LIMIT;
  }
  return sanitized;
}

function findHeaderValue(headers, targetName) {
  if (!isRecord(headers)) {
    return undefined;
  }

  const target = targetName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === target) {
      return typeof value === "string" ? value : String(value);
    }
  }

  return undefined;
}

function summarizeRequestBodyValues(values) {
  if (!isRecord(values)) {
    return sanitizeForLogs(values);
  }

  const summary = {};

  if ("maxOutputTokens" in values) {
    summary.maxOutputTokens = values.maxOutputTokens;
  }
  if ("temperature" in values) {
    summary.temperature = values.temperature;
  }
  if ("topP" in values) {
    summary.topP = values.topP;
  }
  if ("topK" in values) {
    summary.topK = values.topK;
  }
  if ("prompt" in values && Array.isArray(values.prompt)) {
    summary.promptItems = values.prompt.length;
  }
  if ("messages" in values && Array.isArray(values.messages)) {
    summary.messageItems = values.messages.length;
  }
  if ("tools" in values && Array.isArray(values.tools)) {
    summary.tools = values.tools.length;
  }
  if ("providerOptions" in values) {
    summary.providerOptions = sanitizeForLogs(values.providerOptions, 1);
  }
  if ("headers" in values) {
    summary.requestHeaders = sanitizeForLogs(values.headers, 1);
  }

  return summary;
}

function describeErrorNode(error) {
  if (!(error instanceof Error)) {
    return {
      kind: typeof error,
      value: sanitizeForLogs(error),
    };
  }

  const node = {
    name: error.name,
    message: truncateForLogs(error.message),
  };

  if (error.stack) {
    node.stackTop = truncateForLogs(
      error.stack.split("\n").slice(0, 7).join("\n"),
    );
  }

  if (APICallError.isInstance(error)) {
    node.apiCall = {
      url: error.url,
      statusCode: error.statusCode,
      isRetryable: error.isRetryable,
      responseHeaders: sanitizeForLogs(error.responseHeaders),
      responseBody: sanitizeForLogs(error.responseBody),
      data: sanitizeForLogs(error.data),
      requestBodySummary: summarizeRequestBodyValues(error.requestBodyValues),
      generationIdFromHeaders: findHeaderValue(
        error.responseHeaders,
        "x-generation-id",
      ),
      requestIdFromHeaders: findHeaderValue(
        error.responseHeaders,
        "x-vercel-id",
      ),
    };
  }

  if (isRecord(error)) {
    if ("statusCode" in error) {
      node.statusCode = sanitizeForLogs(error.statusCode);
    }
    if ("type" in error) {
      node.type = sanitizeForLogs(error.type);
    }
    if ("generationId" in error) {
      node.generationId = sanitizeForLogs(error.generationId);
    }
    if ("response" in error) {
      node.response = sanitizeForLogs(error.response);
    }
    if ("validationError" in error) {
      node.validationError = sanitizeForLogs(error.validationError);
    }
  }

  return node;
}

function collectErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;

  while (
    current !== undefined &&
    current !== null &&
    chain.length < ERROR_CHAIN_LIMIT
  ) {
    if (isRecord(current) && seen.has(current)) {
      chain.push({ kind: "circular", value: "Cause chain is circular." });
      break;
    }

    if (isRecord(current)) {
      seen.add(current);
    }

    chain.push(describeErrorNode(current));

    if (isRecord(current) && "cause" in current) {
      current = current.cause;
      continue;
    }

    break;
  }

  return chain;
}

function logDetailedError(context, error) {
  const report = {
    context,
    at: new Date().toISOString(),
    chain: collectErrorChain(error),
  };

  console.error(`[${context}] Error details:`);
  console.error(JSON.stringify(report, null, 2));
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function toTitleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function toPascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function previewText(text, length = 120) {
  return previewTextShared(text, length);
}

function buildTopicTerms(topic) {
  return buildTopicTermsShared(topic);
}

function lexicalScore(text, terms) {
  return lexicalScoreShared(text, terms);
}

function buildChunksFromText({ text, prefix, sourceName, sourcePath }) {
  return buildChunksFromTextShared({ text, prefix, sourceName, sourcePath });
}

function rankCandidates(chunks, topic, limit = SCOUT_CANDIDATE_LIMIT) {
  const terms = buildTopicTerms(topic);

  const scored = chunks.map((chunk, index) => ({
    ...chunk,
    score: lexicalScore(chunk.text, terms),
    _order: index,
  }));

  scored.sort((a, b) => b.score - a.score || a._order - b._order);

  const withSignal = scored.filter((candidate) => candidate.score > 0);
  const pool = withSignal.length > 0 ? withSignal : scored;
  return pool.slice(0, Math.max(limit, 1));
}

async function readTextFileOrEmpty(filePath, label) {
  const absolutePath = path.resolve(process.cwd(), filePath);

  try {
    const content = await readFile(absolutePath, "utf8");
    return { absolutePath, content };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      console.warn(`[Context] ${label} not found: ${absolutePath}`);
      return { absolutePath, content: "" };
    }

    throw error;
  }
}

async function readOptionalFile(filePath) {
  if (!filePath) {
    return { fileName: "[]", content: "" };
  }

  const absolutePath = path.resolve(process.cwd(), filePath);
  const content = await readFile(absolutePath, "utf8");
  return { fileName: path.basename(filePath), content: content.trim() };
}

async function listSlidePdfs(slidesDir) {
  const absoluteSlidesDir = path.resolve(process.cwd(), slidesDir);

  try {
    const entries = await readdir(absoluteSlidesDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"),
      )
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

async function listSeniorNoteFiles(notesDir) {
  const absoluteNotesDir = path.resolve(process.cwd(), notesDir);

  try {
    const entries = await readdir(absoluteNotesDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (!entry.isFile()) return false;
        const ext = path.extname(entry.name).toLowerCase();
        return ext === ".md" || ext === ".mdx" || ext === ".txt" || ext === ".pdf";
      })
      .map((entry) => {
        const absolutePath = path.join(absoluteNotesDir, entry.name);
        const relativePath = path.relative(process.cwd(), absolutePath);
        const label = path.basename(entry.name, path.extname(entry.name));
        return {
          id: slugify(relativePath) || slugify(entry.name) || "note",
          path: absolutePath,
          label: label || path.basename(entry.name),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      console.warn(`[SeniorNotes] Directory not found: ${absoluteNotesDir}`);
      return [];
    }

    throw error;
  }
}

function parsePagesCount(mutoolInfoOutput) {
  const match = mutoolInfoOutput.match(/Pages:\s+(\d+)/);
  if (!match) {
    return 1;
  }

  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }

  return parsed;
}

async function extractPdfPageTexts(pdfPath) {
  try {
    const info = await execFileAsync("mutool", ["info", pdfPath], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    });

    const pageCount = parsePagesCount(info.stdout);

    const draw = await execFileAsync(
      "mutool",
      ["draw", "-F", "txt", "-o", "-", pdfPath, `1-${pageCount}`],
      {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120000,
      },
    );

    const raw = draw.stdout ?? "";
    const split = raw.split("\f");

    return split
      .map((pageText, index) => ({
        pageNumber: index + 1,
        text: pageText,
      }))
      .filter((page) => page.text.trim().length > 0);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      console.warn(
        `[Slides] mutool not available on PATH. Skipping PDF extraction for ${pdfPath}`,
      );
      return [];
    }

    console.warn(
      `[Slides] Failed to extract text from ${pdfPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function limitByScore(items, limit) {
  return items
    .slice()
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

async function selectChunkIdsWithScout({
  topic,
  sourceLabel,
  candidates,
  selectionModel,
}) {
  if (candidates.length === 0) {
    return { selectedChunkIds: [], rationale: "No candidates provided." };
  }

  const prompt = [
    "You are a strict retrieval scout for medical notes generation.",
    `Topic: ${topic}`,
    `Source: ${sourceLabel}`,
    `Select up to ${SCOUT_SELECTION_LIMIT} chunk IDs that are directly relevant for the topic.`,
    "You must only return IDs that appear in the candidate list.",
    "Prefer chunks that provide disease-specific definitions, etiology, pathophysiology, signs/symptoms, diagnostics, management, and complications.",
    "If two chunks are redundant, keep the more information-dense one.",
    "",
    "Candidate chunks:",
    candidates
      .map(
        (chunk) =>
          `ID: ${chunk.id}\nScoreHint: ${chunk.score}\nText:\n${chunk.text}`,
      )
      .join("\n\n---\n\n"),
  ].join("\n");

  const allowedIds = new Set(candidates.map((chunk) => chunk.id));

  try {
    const result = await generateText({
      model: selectionModel,
      output: Output.object({ schema: CHUNK_SELECTION_SCHEMA }),
      prompt,
      maxOutputTokens: 1200,
    });

    const selectedChunkIds = [];
    for (const id of result.output?.selectedChunkIds ?? []) {
      if (allowedIds.has(id) && !selectedChunkIds.includes(id)) {
        selectedChunkIds.push(id);
      }
      if (selectedChunkIds.length >= SCOUT_SELECTION_LIMIT) {
        break;
      }
    }

    return {
      selectedChunkIds,
      rationale: result.output?.rationale ?? "",
    };
  } catch (error) {
    console.warn(
      `[Scout:${sourceLabel}] Selection model failed. Falling back to lexical ranking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    logDetailedError(`Scout:${sourceLabel}`, error);

    return {
      selectedChunkIds: candidates
        .slice(0, Math.min(SCOUT_SELECTION_LIMIT, candidates.length))
        .map((chunk) => chunk.id),
      rationale: "Fallback lexical selection.",
    };
  }
}

async function selectSlideFilesWithScout({
  topic,
  slideFiles,
  selectionModel,
  topSlides,
}) {
  if (slideFiles.length === 0) {
    return { selectedFileNames: [], rationale: "No slide files provided." };
  }

  const fileList = slideFiles.map((file) => file.fileName);

  const prompt = [
    "You are a strict slide-title selector for medical notes generation.",
    `Topic: ${topic}`,
    `Pick up to ${topSlides} PDF file names from the list below that are most relevant to the topic.`,
    "Only return file names exactly as listed.",
    "Prefer clinically focused and disease-specific slides.",
    "",
    "Available PDF files:",
    ...fileList,
  ].join("\n");

  const allowedNames = new Set(fileList);

  try {
    const result = await generateText({
      model: selectionModel,
      output: Output.object({ schema: SLIDE_SELECTION_SCHEMA }),
      prompt,
      maxOutputTokens: 800,
    });

    const selectedFileNames = [];
    for (const fileName of result.output?.selectedFileNames ?? []) {
      if (allowedNames.has(fileName) && !selectedFileNames.includes(fileName)) {
        selectedFileNames.push(fileName);
      }
      if (selectedFileNames.length >= topSlides) {
        break;
      }
    }

    if (selectedFileNames.length > 0) {
      return {
        selectedFileNames,
        rationale: result.output?.rationale ?? "",
      };
    }
  } catch (error) {
    console.warn(
      `[Slides] Title selector failed. Falling back to lexical ranking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    logDetailedError("Slides:selector", error);
  }

  const terms = buildTopicTerms(topic);
  const fallback = slideFiles
    .map((file, index) => ({
      fileName: file.fileName,
      score: lexicalScore(file.fileName, terms),
      index,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(topSlides, slideFiles.length))
    .map((entry) => entry.fileName);

  return {
    selectedFileNames: fallback,
    rationale: "Fallback lexical title matching.",
  };
}

function assembleContextForPromptOne({
  noteSelections,
  slideChunks,
  contextBudgetChars = CONTEXT_CHAR_BUDGET,
}) {
  const groups = [
    ...noteSelections.map((selection) => ({
      key: selection.groupKey,
      title: `### Senior Note: ${selection.label} (Verbatim)`,
      items: selection.chunks,
    })),
    {
      key: "slides",
      title: "### Lecture Slides (Extracted Verbatim Text)",
      items: slideChunks,
    },
  ];

  const selected = [];
  const selectedIds = new Set();
  let usedChars = 0;

  const allByScore = [];
  for (const group of groups) {
    const sorted = group.items
      .slice()
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    if (sorted.length > 0) {
      allByScore.push({ ...sorted[0], group: group.key, _seed: true });
      for (const item of sorted.slice(1)) {
        allByScore.push({ ...item, group: group.key, _seed: false });
      }
    }
  }

  allByScore.sort((a, b) => {
    if (a._seed !== b._seed) {
      return a._seed ? -1 : 1;
    }

    return b.score - a.score || a.id.localeCompare(b.id);
  });

  for (const chunk of allByScore) {
    if (selectedIds.has(chunk.id)) {
      continue;
    }

    const estimatedSize = chunk.text.length + 220;
    if (usedChars + estimatedSize > contextBudgetChars) {
      continue;
    }

    selected.push(chunk);
    selectedIds.add(chunk.id);
    usedChars += estimatedSize;
  }

  const parts = [];

  for (const group of groups) {
    const groupSelected = selected.filter((chunk) => chunk.group === group.key);

    if (groupSelected.length === 0) {
      continue;
    }

    parts.push(group.title);

    for (const chunk of groupSelected) {
      parts.push(
        `#### [${chunk.id}] Source: ${chunk.sourceName}\n${chunk.text}`,
      );
    }
  }

  return {
    contextText: parts.join("\n\n"),
    selected,
    usedChars,
  };
}

async function prepareContextSources(options) {
  const noteSources = [];
  const chunkById = new Map();

  for (const note of options.seniorNotes) {
    const absolutePath = path.resolve(process.cwd(), note.path);
    const groupKey = `note:${note.id}`;
    let chunks = [];
    if (isPdfFilePath(absolutePath)) {
      const pages = await extractPdfPageTexts(absolutePath);
      for (const page of pages) {
        const pageChunks = buildChunksFromText({
          text: page.text,
          prefix: `note-${note.id}-p${page.pageNumber}`,
          sourceName: path.basename(absolutePath),
          sourcePath: absolutePath,
        }).map((chunk) => ({
          ...chunk,
          sourceGroup: groupKey,
        }));
        chunks.push(...pageChunks);
      }
    } else {
      const source = await readTextFileOrEmpty(
        note.path,
        `Senior note (${note.label})`,
      );
      chunks = source.content
        ? buildChunksFromText({
            text: source.content,
            prefix: `note-${note.id}`,
            sourceName: path.basename(source.absolutePath),
            sourcePath: source.absolutePath,
          }).map((chunk) => ({
            ...chunk,
            sourceGroup: groupKey,
          }))
        : [];
    }

    for (const chunk of chunks) {
      chunkById.set(chunk.id, chunk);
    }

    noteSources.push({
      id: note.id,
      label: note.label,
      path: note.path,
      absolutePath,
      chunks,
      groupKey,
    });
  }

  const slideFiles = await listSlidePdfs(options.slidesDir);

  return {
    noteSources,
    slideFiles,
    chunkById,
  };
}

async function buildSlideChunksForTopic({ topic, selectedFiles, maxChunks }) {
  const terms = buildTopicTerms(topic);
  const perFileSelected = [];

  for (const file of selectedFiles) {
    const pages = await extractPdfPageTexts(file.absolutePath);

    if (pages.length === 0) {
      continue;
    }

    const rankedPages = pages
      .map((page) => ({
        id: `slide:${file.fileName}:p${page.pageNumber}`,
        sourceName: file.fileName,
        text: page.text,
        score: lexicalScore(`${file.fileName}\n${page.text}`, terms),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const localPick = rankedPages
      .filter((page) => page.score > 0)
      .slice(0, LEGACY_SLIDE_PAGES_PER_FILE);
    if (localPick.length > 0) {
      perFileSelected.push(...localPick);
      continue;
    }

    perFileSelected.push(rankedPages[0]);
  }

  return limitByScore(perFileSelected, maxChunks);
}

async function buildRetrievedContextForTopic({
  topic,
  contextSources,
  selectionModel,
  topSlides,
}) {
  const noteSelections = [];
  for (const noteSource of contextSources.noteSources) {
    const candidates = rankCandidates(noteSource.chunks, topic);
    const selection = await selectChunkIdsWithScout({
      topic,
      sourceLabel: noteSource.label,
      candidates,
      selectionModel,
    });

    const fallbackIds = candidates
      .slice(0, Math.min(SCOUT_SELECTION_LIMIT, candidates.length))
      .map((chunk) => chunk.id);
    const selectedIds =
      selection.selectedChunkIds.length > 0
        ? selection.selectedChunkIds
        : fallbackIds;

    const candidateScoreById = new Map(
      candidates.map((candidate) => [candidate.id, candidate.score]),
    );
    const chunks = selectedIds
      .map((id) => {
        const chunk = contextSources.chunkById.get(id);
        if (!chunk) {
          return undefined;
        }
        return {
          ...chunk,
          score: candidateScoreById.get(id) ?? 0,
        };
      })
      .filter(Boolean);

    console.log(
      `[Context][${topic}] ${noteSource.label} IDs: ${
        chunks.map((chunk) => chunk.id).join(", ") || "none"
      }`,
    );
    for (const chunk of chunks) {
      console.log(
        `[Context][${topic}] ${noteSource.label} preview ${chunk.id}: ${previewText(chunk.text)}`,
      );
    }

    noteSelections.push({
      groupKey: noteSource.groupKey,
      label: noteSource.label,
      chunks,
      sourceName: path.basename(noteSource.absolutePath),
    });
  }

  const slideSelection = await selectSlideFilesWithScout({
    topic,
    slideFiles: contextSources.slideFiles,
    selectionModel,
    topSlides,
  });

  const slideLookup = new Map(
    contextSources.slideFiles.map((file) => [file.fileName, file]),
  );

  const selectedSlideFiles = slideSelection.selectedFileNames
    .map((fileName) => slideLookup.get(fileName))
    .filter(Boolean);

  console.log(
    `[Context][${topic}] Slide files: ${
      selectedSlideFiles.map((file) => file.fileName).join(", ") || "none"
    }`,
  );

  const slideChunks = await buildSlideChunksForTopic({
    topic,
    selectedFiles: selectedSlideFiles,
    maxChunks: MAX_SLIDE_PAGE_CHUNKS,
  });

  console.log(
    `[Context][${topic}] Slide page IDs: ${slideChunks.map((chunk) => chunk.id).join(", ") || "none"}`,
  );
  for (const chunk of slideChunks) {
    console.log(
      `[Context][${topic}] Slide preview ${chunk.id}: ${previewText(chunk.text)}`,
    );
  }

  const assembled = assembleContextForPromptOne({
    noteSelections,
    slideChunks,
  });

  console.log(
    `[Context][${topic}] Injected context chars: ${assembled.usedChars}`,
  );

  return {
    contextText: assembled.contextText,
    contextLabel: [
      ...noteSelections.map((selection) => selection.sourceName),
      ...selectedSlideFiles.map((file) => file.fileName),
    ].join(" + "),
    selectedSlideFileNames: selectedSlideFiles.map((file) => file.fileName),
  };
}

function formatPromptArray(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "";
  }

  const normalized = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }

  return normalized.map((value) => JSON.stringify(value)).join(", ");
}

async function selectSlideFileNamesForPrompt({
  topic,
  indexedContext,
  topSlides,
}) {
  const query = topic;
  let queryEmbedding = null;

  try {
    const result = await embedSingleValue({
      model: indexedContext.embeddingModel,
      value: query,
    });
    queryEmbedding = result.embedding;
  } catch (error) {
    console.warn(
      `[Embed][${topic}:prompt-file-list] Failed. Falling back to lexical-only slide ranking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const rankedSlideFiles = rankSlideFilesByHybrid({
    topic: query,
    slideFiles: indexedContext.slides,
    queryEmbedding,
  });

  return rankedSlideFiles.slice(0, topSlides).map((file) => file.fileName);
}

async function selectMergedChunkIdsWithScout({
  topic,
  sectionName,
  candidates,
  selectionModel,
}) {
  if (candidates.length === 0) {
    return { selectedChunkIds: [], rationale: "No candidates provided." };
  }

  const prompt = [
    "You are a strict retrieval reranker for medical notes generation.",
    `Topic: ${topic}`,
    `Section: ${sectionName}`,
    `Select up to ${SCOUT_SELECTION_LIMIT} chunk IDs that best support this section.`,
    "You must only return IDs from the candidate list.",
    "Prefer information-dense, high-signal chunks with direct clinical relevance.",
    "",
    "Candidate chunks:",
    candidates
      .map(
        (chunk) =>
          `ID: ${chunk.id}\nSourceGroup: ${chunk.sourceGroup}\nScoreHint: ${chunk.score}\nText:\n${chunk.text}`,
      )
      .join("\n\n---\n\n"),
  ].join("\n");

  const allowedIds = new Set(candidates.map((chunk) => chunk.id));

  try {
    const result = await generateText({
      model: selectionModel,
      output: Output.object({ schema: CHUNK_SELECTION_SCHEMA }),
      prompt,
      maxOutputTokens: 1200,
    });

    const selectedChunkIds = [];
    for (const id of result.output?.selectedChunkIds ?? []) {
      if (allowedIds.has(id) && !selectedChunkIds.includes(id)) {
        selectedChunkIds.push(id);
      }
      if (selectedChunkIds.length >= SCOUT_SELECTION_LIMIT) {
        break;
      }
    }

    return {
      selectedChunkIds,
      rationale: result.output?.rationale ?? "",
    };
  } catch (error) {
    console.warn(
      `[Scout:${topic}:${sectionName}] Reranker failed. Falling back to hybrid ranking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    logDetailedError(`Scout:${topic}:${sectionName}`, error);

    return {
      selectedChunkIds: candidates
        .slice(0, Math.min(SCOUT_SELECTION_LIMIT, candidates.length))
        .map((candidate) => candidate.id),
      rationale: "Fallback hybrid ranking.",
    };
  }
}

async function readIndexedChunksAndEmbeddings(cacheBaseDir, artifactDir) {
  const absoluteArtifactDir = absFromCache(cacheBaseDir, artifactDir);
  const chunksData = await readJsonIfExists(
    path.join(absoluteArtifactDir, "chunks.json"),
    null,
  );
  const embeddingsData = await readJsonIfExists(
    path.join(absoluteArtifactDir, "chunks.embedding.json"),
    null,
  );

  if (!chunksData || !embeddingsData) {
    return null;
  }

  const chunks = Array.isArray(chunksData.chunks) ? chunksData.chunks : [];
  const chunkIds = Array.isArray(embeddingsData.chunkIds)
    ? embeddingsData.chunkIds
    : [];
  const embeddings = Array.isArray(embeddingsData.embeddings)
    ? embeddingsData.embeddings
    : [];

  const embeddingById = new Map();
  for (let i = 0; i < chunkIds.length; i += 1) {
    const id = chunkIds[i];
    const embedding = embeddings[i];
    if (id && Array.isArray(embedding)) {
      embeddingById.set(id, embedding);
    }
  }

  return {
    chunks,
    embeddingById,
  };
}

async function readIndexedSlideArtifacts(cacheBaseDir, artifactDir) {
  const absoluteArtifactDir = absFromCache(cacheBaseDir, artifactDir);
  const summaryData = await readJsonIfExists(
    path.join(absoluteArtifactDir, "summary.json"),
    null,
  );
  const summaryEmbeddingData = await readJsonIfExists(
    path.join(absoluteArtifactDir, "summary.embedding.json"),
    null,
  );
  const chunksAndEmbeddings = await readIndexedChunksAndEmbeddings(
    cacheBaseDir,
    artifactDir,
  );

  if (!summaryData || !summaryEmbeddingData || !chunksAndEmbeddings) {
    return null;
  }

  return {
    summaryText: String(summaryData.summary ?? ""),
    summaryEmbedding: Array.isArray(summaryEmbeddingData.embedding)
      ? summaryEmbeddingData.embedding
      : null,
    chunks: chunksAndEmbeddings.chunks,
    chunkEmbeddingById: chunksAndEmbeddings.embeddingById,
  };
}

function buildIndexCommandHint(options) {
  const notesArgs = options.seniorNotes
    .map((note) => `--senior-note ${JSON.stringify(note.path)}`)
    .join(" ");
  const notesDirArgs = options.seniorNotesDirs
    .map((notesDir) => `--senior-notes-dir ${JSON.stringify(notesDir)}`)
    .join(" ");
  return `npm run index:rag -- --specialty "${options.specialty}" --slides-dir "${options.slidesDir}" --cache-dir "${options.cacheDir}" ${notesArgs} ${notesDirArgs}`.trim();
}

async function listCacheReadinessIssues(options, manifest) {
  const issues = [];
  const requiredByPath = new Map();

  const requiredNotes = options.seniorNotes.map((note) =>
    path.resolve(process.cwd(), note.path),
  );
  for (const notePath of requiredNotes) {
    requiredByPath.set(notePath, isPdfFilePath(notePath) ? "pdf" : "note");
  }

  const slides = await listSlidePdfs(options.slidesDir);
  for (const slide of slides) {
    requiredByPath.set(slide.absolutePath, "pdf");
  }

  for (const [absolutePath, expectedType] of requiredByPath.entries()) {
    const entry = manifest.sources[absolutePath];
    if (!entry) {
      issues.push({ path: absolutePath, reason: "missing_manifest_entry" });
      continue;
    }

    if (entry.type !== expectedType) {
      issues.push({
        path: absolutePath,
        reason: `type_mismatch_expected_${expectedType}`,
      });
      continue;
    }

    const entrySpecialty = String(entry.specialty ?? "");
    if (entrySpecialty !== options.specialty) {
      issues.push({
        path: absolutePath,
        reason: `specialty_mismatch:${entrySpecialty || "missing"}!=${options.specialty}`,
      });
      continue;
    }

    if (entry.modelId !== manifest.embeddingModel) {
      issues.push({ path: absolutePath, reason: "embedding_model_mismatch" });
      continue;
    }

    if (entry.chunkingVersion !== INDEX_CHUNKING_VERSION) {
      issues.push({ path: absolutePath, reason: "chunking_version_mismatch" });
      continue;
    }

    try {
      const sourceStat = await stat(absolutePath);
      if (!sourceStat.isFile()) {
        issues.push({ path: absolutePath, reason: "source_not_file" });
        continue;
      }

      const sizeChanged = Number(entry.size) !== Number(sourceStat.size);
      const mtimeChanged =
        Math.floor(Number(entry.mtimeMs)) !== Math.floor(sourceStat.mtimeMs);
      if (sizeChanged || mtimeChanged) {
        issues.push({
          path: absolutePath,
          reason: "source_changed_since_index",
        });
      }
    } catch (error) {
      issues.push({
        path: absolutePath,
        reason:
          error instanceof Error
            ? `source_unreadable:${error.message}`
            : "source_unreadable",
      });
    }
  }

  return issues;
}

async function prepareIndexedContextSources(options) {
  const { baseDir: cacheBaseDir, manifestPath } = resolveCachePaths(
    options.cacheDir,
  );
  const manifest = await readManifest(manifestPath);
  const embeddingModel = manifest.embeddingModel || DEFAULT_EMBEDDING_MODEL;

  const issues = await listCacheReadinessIssues(options, manifest);
  if (issues.length > 0 && !options.allowStaleIndex) {
    const reasons = issues
      .slice(0, 12)
      .map((issue) => `- ${issue.reason}: ${issue.path}`)
      .join("\n");
    throw new Error(
      [
        "RAG index is missing or stale.",
        `Run: ${buildIndexCommandHint(options)}`,
        reasons,
      ].join("\n"),
    );
  }

  if (issues.length > 0 && options.allowStaleIndex) {
    console.warn(
      `[Index] Proceeding with stale index (--allow-stale-index). Issues: ${issues.length}`,
    );
  }

  const indexedNotes = [];
  for (const note of options.seniorNotes) {
    const notePath = path.resolve(process.cwd(), note.path);
    const noteIsPdf = isPdfFilePath(notePath);
    const entry = manifest.sources[notePath];
    if (!entry?.artifactDir || entry.specialty !== options.specialty) {
      return null;
    }

    let chunks = [];
    let embeddingById = new Map();
    if (noteIsPdf) {
      const indexed = await readIndexedSlideArtifacts(
        cacheBaseDir,
        entry.artifactDir,
      );
      if (!indexed) {
        return null;
      }
      chunks = indexed.chunks.map((chunk) => ({
        ...chunk,
        sourceName: chunk.sourceName || path.basename(notePath),
      }));
      embeddingById = indexed.chunkEmbeddingById;
    } else {
      const indexed = await readIndexedChunksAndEmbeddings(
        cacheBaseDir,
        entry.artifactDir,
      );
      if (!indexed) {
        return null;
      }
      chunks = indexed.chunks.map((chunk) => ({
        ...chunk,
        sourceName: chunk.sourceName || path.basename(notePath),
      }));
      embeddingById = indexed.embeddingById;
    }

    const groupKey = `note:${note.id}`;
    indexedNotes.push({
      id: note.id,
      label: note.label,
      sourcePath: notePath,
      groupKey,
      chunks: chunks.map((chunk) => ({
        ...chunk,
        sourceGroup: groupKey,
      })),
      embeddingById,
    });
  }

  const slideFiles = await listSlidePdfs(options.slidesDir);
  const indexedSlides = [];
  for (const slideFile of slideFiles) {
    const entry = manifest.sources[slideFile.absolutePath];
    if (!entry?.artifactDir || entry.specialty !== options.specialty) {
      continue;
    }
    const indexed = await readIndexedSlideArtifacts(
      cacheBaseDir,
      entry.artifactDir,
    );
    if (!indexed) {
      continue;
    }

    indexedSlides.push({
      fileName: slideFile.fileName,
      sourcePath: slideFile.absolutePath,
      summaryText: indexed.summaryText,
      summaryEmbedding: indexed.summaryEmbedding,
      chunks: indexed.chunks.map((chunk) => ({
        ...chunk,
        sourceGroup: "slides",
      })),
      chunkEmbeddingById: indexed.chunkEmbeddingById,
    });
  }

  return {
    manifest,
    cacheBaseDir,
    embeddingModel,
    specialty: options.specialty,
    notes: indexedNotes,
    slides: indexedSlides,
  };
}

async function buildRetrievedContextForSectionFromIndex({
  topic,
  sectionName,
  indexedContext,
  selectionModel,
  topSlides,
}) {
  const query = buildSectionQuery(topic, sectionName);
  let queryEmbedding = null;
  try {
    const result = await embedSingleValue({
      model: indexedContext.embeddingModel,
      value: query,
    });
    queryEmbedding = result.embedding;
  } catch (error) {
    console.warn(
      `[Embed][${topic}:${sectionName}] Failed. Falling back to lexical-only ranking: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    logDetailedError(`Embed:${topic}:${sectionName}`, error);
  }

  const rankedSlideFiles = rankSlideFilesByHybrid({
    topic: query,
    slideFiles: indexedContext.slides,
    queryEmbedding,
  });
  const selectedSlideFiles = rankedSlideFiles.slice(0, topSlides);

  const slideChunks = selectedSlideFiles.flatMap((file) => file.chunks);
  const slideEmbeddingById = new Map();
  for (const file of selectedSlideFiles) {
    for (const [id, embedding] of file.chunkEmbeddingById.entries()) {
      slideEmbeddingById.set(id, embedding);
    }
  }

  const rankedSources = indexedContext.notes.map((note) => ({
    sourceGroup: note.groupKey,
    items: rankChunksHybrid({
      query,
      chunks: note.chunks,
      embeddingById: note.embeddingById,
      queryEmbedding,
    }).slice(0, SECTION_PER_SOURCE_RANK_LIMIT),
  }));
  rankedSources.push({
    sourceGroup: "slides",
    items: rankChunksHybrid({
      query,
      chunks: slideChunks,
      embeddingById: slideEmbeddingById,
      queryEmbedding,
    }).slice(0, SECTION_PER_SOURCE_RANK_LIMIT),
  });

  const mergedCandidates = mergeSourceBalanced({
    rankedSources,
    perSourceCap: SECTION_MERGE_PER_SOURCE_CAP,
    candidateLimit: SECTION_MERGE_CANDIDATE_LIMIT,
  });

  const selection = await selectMergedChunkIdsWithScout({
    topic,
    sectionName,
    candidates: mergedCandidates,
    selectionModel,
  });

  const selectedById = new Map(
    mergedCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const selectedChunks = [];
  for (const chunkId of selection.selectedChunkIds) {
    const chunk = selectedById.get(chunkId);
    if (chunk) {
      selectedChunks.push(chunk);
    }
  }

  if (selectedChunks.length === 0) {
    selectedChunks.push(
      ...mergedCandidates.slice(
        0,
        Math.min(SCOUT_SELECTION_LIMIT, mergedCandidates.length),
      ),
    );
  }

  const assembled = assembleSectionContext({
    selectedChunks,
    contextBudgetChars: SECTION_CONTEXT_CHAR_BUDGET,
    groupOrder: [
      ...indexedContext.notes.map((note) => note.groupKey),
      "slides",
    ],
    groupedTitles: {
      ...Object.fromEntries(
        indexedContext.notes.map((note) => [
          note.groupKey,
          `### Senior Note: ${note.label} (Indexed)`,
        ]),
      ),
      slides: "### Lecture Slides (Indexed)",
    },
  });

  console.log(
    `[Context][${topic}:${sectionName}] Slides: ${
      selectedSlideFiles.map((file) => file.fileName).join(", ") || "none"
    }`,
  );
  console.log(
    `[Context][${topic}:${sectionName}] Selected IDs: ${assembled.selected.map((item) => item.id).join(", ") || "none"}`,
  );
  console.log(
    `[Context][${topic}:${sectionName}] Injected context chars: ${assembled.usedChars}`,
  );

  return {
    contextText: assembled.contextText,
    selectedChunks: assembled.selected,
  };
}

function buildPromptOne({
  template,
  condition,
  sampleNotesFileName,
  powerpointFileNames,
  sampleNotesContent,
  slidesContent,
}) {
  let prompt = template
    .replaceAll("{{condition}}", condition)
    .replaceAll("{{sampleNotesFileName}}", sampleNotesFileName)
    .replaceAll("{{powerpointFileNames}}", powerpointFileNames ?? "");

  if (sampleNotesContent) {
    prompt += `\n\nReference context (verbatim scout-selected and extracted):\n\n${sampleNotesContent}`;
  }

  if (slidesContent) {
    prompt += `\n\nLecture slides content (treat as high yield and mark those points with bold + italics):\n\n${slidesContent}`;
  }

  return prompt;
}

function resolveSectionPlan(options) {
  if (!options.oneShot) {
    return DEFAULT_SECTION_PLAN.slice();
  }

  const profile =
    PROMPT_PROFILES[options.promptProfile] ?? PROMPT_PROFILES.default;
  return [profile.oneShotSection];
}

function resolvePromptTemplate({ promptProfile, customPromptTemplate }) {
  if (customPromptTemplate) {
    return customPromptTemplate;
  }

  const profile = PROMPT_PROFILES[promptProfile] ?? PROMPT_PROFILES.default;
  return profile.template;
}

const TOPIC_DESCRIPTION_PROMPT = `You are a medical education assistant. Given a medical topic name, respond with exactly one short sentence: a succinct clinical definition (what it is). No preamble, no quotes, no bullet points. Example: for "Liver cirrhosis" → Chronic liver disease characterized by fibrosis and regenerative nodules leading to loss of function.

Topic: {{topic}}
One-line definition:`;

async function generateTopicDescription({ topic, title, model }) {
  const prompt = TOPIC_DESCRIPTION_PROMPT.replace("{{topic}}", title || topic);
  try {
    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 150,
    });
    const definition = result.text?.trim();
    return definition || null;
  } catch (error) {
    logDetailedError(`${topic}:description`, error);
    return null;
  }
}

function buildTopicDocMdx({
  title,
  specialty,
  slug,
  description,
  sectionPlan,
}) {
  const desc =
    description != null && description !== ""
      ? JSON.stringify(description)
      : `Definition and clinical overview of ${title}.`;
  const sections = sectionPlan?.length ? sectionPlan : DEFAULT_SECTION_PLAN;

  const imports = sections
    .map(({ fileName }) => {
      const componentName = `${toPascalCase(fileName) || "Section"}Section`;
      return `import ${componentName} from "../../fragments/${specialty}/${slug}/${fileName}.mdx";`;
    })
    .join("\n");

  const tabsItems = sections
    .map(({ tabName }) => JSON.stringify(tabName))
    .join(", ");

  const tabBlocks = sections
    .map(({ fileName, tabName }) => {
      const componentName = `${toPascalCase(fileName) || "Section"}Section`;
      return `<Tab value=${JSON.stringify(tabName)}>
  <${componentName} components={props.components} />

</Tab>`;
    })
    .join("\n\n");

  return `---
title: ${title}
description: ${desc}
---

${imports}

<Tabs items={[${tabsItems}]}>

${tabBlocks}

</Tabs>
`;
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
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

async function loadCustomPromptTemplate(promptFilePath) {
  if (!promptFilePath) {
    return "";
  }

  const absolutePath = path.resolve(process.cwd(), promptFilePath);
  const content = await readFile(absolutePath, "utf8");
  const trimmed = content.trim();

  if (!trimmed) {
    throw new Error(`Prompt file is empty: ${promptFilePath}`);
  }

  return trimmed;
}

async function generateSingleSection({
  messages,
  model,
  prompt,
  topic,
  sectionName,
}) {
  messages.push({ role: "user", content: prompt });

  console.log(`[${topic}] Generating ${sectionName}...`);

  let result;
  try {
    result = await generateText({
      model,
      messages,
    });
  } catch (error) {
    logDetailedError(`${topic}:${sectionName}`, error);
    throw error;
  }

  const text = result.text?.trim();
  if (!text) {
    throw new Error(`Model returned empty text for section: ${sectionName}`);
  }

  if (result.response?.messages?.length) {
    messages.push(...result.response.messages);
  } else {
    messages.push({ role: "assistant", content: text });
  }

  return text;
}

async function generateTopic({
  topic,
  model,
  specialty,
  promptTemplate,
  oneShot,
  sectionPlan,
  sampleNotesFileName,
  powerpointFileNames,
  sampleNotesContent,
  slidesContent,
  contextProvider,
}) {
  const slug = slugify(topic);
  const title = toTitleCase(topic);

  if (!slug) {
    throw new Error(`Could not generate slug for topic: "${topic}"`);
  }

  const fragmentsDir = path.join(
    process.cwd(),
    "content",
    "fragments",
    specialty,
    slug,
  );
  const docsDir = path.join(process.cwd(), "content", "docs", specialty);
  const topicDocPath = path.join(docsDir, `${slug}.mdx`);

  await mkdir(fragmentsDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });

  const messages = [];

  const resolvedSectionPlan =
    sectionPlan?.length > 0 ? sectionPlan : DEFAULT_SECTION_PLAN;

  const prompts = [
    buildPromptOne({
      template: promptTemplate,
      condition: topic,
      sampleNotesFileName,
      powerpointFileNames,
      sampleNotesContent,
      slidesContent,
    }),
  ];

  if (!oneShot) {
    prompts.push(...FOLLOW_UP_PROMPTS);
  }

  if (prompts.length !== resolvedSectionPlan.length) {
    throw new Error(
      `Prompt/section count mismatch (${prompts.length} prompts vs ${resolvedSectionPlan.length} sections).`,
    );
  }

  for (let i = 0; i < prompts.length; i += 1) {
    const section = resolvedSectionPlan[i];
    const sectionFileName = section.fileName;
    const sectionTabName = section.tabName;
    let sectionPrompt = prompts[i];

    if (typeof contextProvider === "function") {
      const sectionContext = await contextProvider({
        topic,
        sectionName: sectionTabName,
        sectionIndex: i,
      });

      if (sectionContext?.contextText) {
        sectionPrompt += `\n\nReference context (retrieved and source-bounded):\n\n${sectionContext.contextText}`;
      }
    }

    const content = await generateSingleSection({
      messages,
      model,
      prompt: sectionPrompt,
      topic,
      sectionName: sectionTabName,
    });

    const fragmentPath = path.join(fragmentsDir, `${sectionFileName}.mdx`);
    await writeFile(fragmentPath, ensureTrailingNewline(content), "utf8");
    console.log(`[${topic}] Wrote ${fragmentPath}`);
  }

  console.log(`[${topic}] Generating one-line description...`);
  const description = await generateTopicDescription({ topic, title, model });
  const topicDoc = buildTopicDocMdx({
    title,
    specialty,
    slug,
    description,
    sectionPlan: resolvedSectionPlan,
  });
  await writeFile(topicDocPath, topicDoc, "utf8");
  console.log(`[${topic}] Wrote ${topicDocPath}`);
}

async function main() {
  await loadDotEnvFiles();

  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (options.topics.length === 0) {
    printUsage();
    throw new Error("At least one topic is required.");
  }

  for (const notesDir of options.seniorNotesDirs) {
    const discoveredNotes = await listSeniorNoteFiles(notesDir);
    for (const note of discoveredNotes) {
      options.seniorNotes = upsertSeniorNoteByPath(options.seniorNotes, note);
    }
  }

  if (options.seniorNotes.length === 0) {
    throw new Error(
      "At least one senior note is required. Use --senior-note or --senior-notes-dir.",
    );
  }

  const customPromptTemplate = await loadCustomPromptTemplate(
    options.promptFilePath,
  );
  const promptTemplate = resolvePromptTemplate({
    promptProfile: options.promptProfile,
    customPromptTemplate,
  });
  const sectionPlan = resolveSectionPlan(options);

  const generationModel = buildLanguageModel(options.model, options.devtools);
  const selectionModel = buildLanguageModel(
    options.selectionModel,
    options.devtools,
  );

  console.log(`Model: ${options.model}`);
  console.log(`Selection model: ${options.selectionModel}`);
  console.log(`Specialty: ${options.specialty}`);
  console.log(`Prompt profile: ${options.promptProfile}`);
  console.log(`One-shot: ${options.oneShot ? "enabled" : "disabled"}`);
  if (options.promptFilePath) {
    console.log(`Custom prompt file: ${options.promptFilePath}`);
  }
  console.log(`DevTools: ${options.devtools ? "enabled" : "disabled"}`);
  console.log(
    `Context scouts: ${options.contextScouts ? "enabled" : "disabled"}`,
  );
  console.log(`Slides dir: ${options.slidesDir}`);
  console.log(`Top slides: ${options.topSlides}`);
  console.log(`Topic concurrency: ${options.topicConcurrency}`);
  console.log(`Cache dir: ${options.cacheDir}`);
  console.log(
    `Allow stale index: ${options.allowStaleIndex ? "enabled" : "disabled"}`,
  );
  if (options.seniorNotesDirs.length > 0) {
    console.log(`Senior note dirs: ${options.seniorNotesDirs.join(", ")}`);
  }
  console.log(`Topics: ${options.topics.join(", ")}`);
  console.log(
    `Senior notes: ${options.seniorNotes.map((note) => `${note.id}=${note.path}`).join(", ")}`,
  );

  const promptNoteFileNames = Array.from(
    new Set(options.seniorNotes.map((note) => path.basename(note.path))),
  );

  if (!options.contextScouts) {
    const sampleNotes = await readOptionalFile(options.sampleNotePath);
    const slides = await readOptionalFile(options.slidesPath);

    console.log(`Legacy sample notes file: ${sampleNotes.fileName}`);
    console.log(`Legacy slides file: ${slides.fileName}`);

    await runWithConcurrency(
      options.topics,
      options.topicConcurrency,
      async (topic) =>
        generateTopic({
          topic,
          model: generationModel,
          specialty: options.specialty,
          promptTemplate,
          oneShot: options.oneShot,
          sectionPlan,
          sampleNotesFileName: formatPromptArray([sampleNotes.fileName]),
          powerpointFileNames: formatPromptArray([slides.fileName]),
          sampleNotesContent: sampleNotes.content,
          slidesContent: slides.content,
        }),
    );

    return;
  }

  const indexedContext = await prepareIndexedContextSources(options);

  if (indexedContext) {
    for (const note of indexedContext.notes) {
      console.log(`Indexed ${note.label} chunks: ${note.chunks.length}`);
    }
    console.log(`Indexed slide files: ${indexedContext.slides.length}`);
    console.log(`Embedding model: ${indexedContext.embeddingModel}`);

    await runWithConcurrency(
      options.topics,
      options.topicConcurrency,
      async (topic) => {
        const promptSlideFileNames = await selectSlideFileNamesForPrompt({
          topic,
          indexedContext,
          topSlides: options.topSlides,
        });

        await generateTopic({
          topic,
          model: generationModel,
          specialty: options.specialty,
          promptTemplate,
          oneShot: options.oneShot,
          sectionPlan,
          sampleNotesFileName: formatPromptArray(promptNoteFileNames),
          powerpointFileNames: formatPromptArray(promptSlideFileNames),
          sampleNotesContent: "",
          slidesContent: "",
          contextProvider: ({ sectionName }) =>
            buildRetrievedContextForSectionFromIndex({
              topic,
              sectionName,
              indexedContext,
              selectionModel,
              topSlides: options.topSlides,
            }),
        });
      },
    );

    return;
  }

  if (options.allowStaleIndex) {
    console.warn(
      "[Index] Indexed artifacts unavailable. Falling back to legacy retrieval pipeline because --allow-stale-index is enabled.",
    );
    const contextSources = await prepareContextSources(options);

    for (const noteSource of contextSources.noteSources) {
      console.log(`${noteSource.label} chunks: ${noteSource.chunks.length}`);
    }
    console.log(`Slide PDFs: ${contextSources.slideFiles.length}`);

    await runWithConcurrency(
      options.topics,
      options.topicConcurrency,
      async (topic) => {
        const retrieved = await buildRetrievedContextForTopic({
          topic,
          contextSources,
          selectionModel,
          topSlides: options.topSlides,
        });

        await generateTopic({
          topic,
          model: generationModel,
          specialty: options.specialty,
          promptTemplate,
          oneShot: options.oneShot,
          sectionPlan,
          sampleNotesFileName: formatPromptArray(promptNoteFileNames),
          powerpointFileNames: formatPromptArray(
            retrieved.selectedSlideFileNames ?? [],
          ),
          sampleNotesContent: retrieved.contextText,
          slidesContent: "",
        });
      },
    );

    return;
  }

  throw new Error(
    `RAG index unavailable. Run: ${buildIndexCommandHint(options)}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  logDetailedError("generate-notes", error);
  process.exitCode = 1;
});
