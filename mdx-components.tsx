import defaultMdxComponents from "fumadocs-ui/mdx";
import * as TabsComponents from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import { Mermaid } from "./components/mdx/mermaid";
import { ActiveRecallQuiz } from "./components/mdx/active-recall-quiz";
import { Cite, References } from "./components/mdx/citations";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Mermaid,
    ActiveRecallQuiz,
    Cite,
    References,
    ...TabsComponents,
    ...components,
  };
}
