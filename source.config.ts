import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { remarkCitations } from "./lib/mdx/remark-citations";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMath, remarkMdxMermaid, remarkCitations],
    rehypePlugins: (v) => [rehypeKatex, ...v],
  },
});
