import { source } from "@/lib/source";

export const revalidate = false;

export function GET() {
  const pageUrls = source
    .getPages()
    .map((page) => page.url)
    .filter((url) => url !== "/")
    .sort((a, b) => a.localeCompare(b));

  const lines = [
    "# MBBSPedia LLM Index",
    "",
    "- /llms-full.txt",
    "",
    "## Markdown Endpoints",
    ...pageUrls.map((url) => `- ${url}.mdx`),
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
