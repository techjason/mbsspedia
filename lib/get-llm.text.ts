import { source } from "@/lib/source";
import { cleanMdxForIndexing, getImportedMdxTextForPage } from "@/lib/mdx-imports";
import type { InferPageType } from "fumadocs-core/source";

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed");
  const imported = await getImportedMdxTextForPage(page.path);
  const body = [cleanMdxForIndexing(processed), imported]
    .filter(Boolean)
    .join("\n\n");

  return `# ${page.data.title} (${page.url})

${body}`;
}
