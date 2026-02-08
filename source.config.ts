import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { remarkCitations } from "./lib/mdx/remark-citations";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid, remarkCitations],
  },
});
