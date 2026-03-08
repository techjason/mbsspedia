import { source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/notebook/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/mdx-components";
import type { Metadata } from "next";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { TabAwareTOC } from "@/components/mdx/tab-aware-toc";
import {
  CollapseAllButton,
  ExpandAllButton,
  LLMCopyButton,
  ViewOptions,
} from "@/components/page-actions";
import { readFile } from "node:fs/promises";
import path from "node:path";

type FragmentTabKey =
  | "etiology"
  | "ddx"
  | "dx"
  | "mx"
  | "complications"
  | "summary"
  | "memory-palace";

const SECTION_IMPORT_TO_TAB_KEY: Record<string, FragmentTabKey> = {
  EtiologySection: "etiology",
  DdxSection: "ddx",
  DxSection: "dx",
  MxSection: "mx",
  ComplicationsSection: "complications",
  SummarySection: "summary",
  MemoryPalaceSection: "memory-palace",
};

function getGithubUrl(pagePath: string) {
  return `https://github.com/techjason/mbbspedia/blob/main/content/docs/${pagePath}`;
}

function getGithubUrlFromRepoPath(repoPath: string) {
  const normalizedPath = repoPath.replace(/\\/g, "/");
  return `https://github.com/techjason/mbbspedia/blob/main/${normalizedPath}`;
}

async function getFragmentGithubUrls(pagePath: string) {
  const docsRepoPath = path.posix.join("content/docs", pagePath);
  const docsAbsPath = path.join(process.cwd(), docsRepoPath);

  const fragmentGithubUrls: Partial<Record<FragmentTabKey, string>> = {};

  try {
    const source = await readFile(docsAbsPath, "utf8");
    const importRegex = /import\s+(\w+)\s+from\s+["']([^"']+)["'];/g;
    const docsDir = path.dirname(docsAbsPath);

    for (const match of source.matchAll(importRegex)) {
      const sectionName = match[1];
      const importPath = match[2];
      const tabKey = SECTION_IMPORT_TO_TAB_KEY[sectionName];

      if (!tabKey || !importPath.endsWith(".mdx")) continue;

      const resolvedAbsPath = path.resolve(docsDir, importPath);
      const repoRelativePath = path.relative(process.cwd(), resolvedAbsPath);

      if (!repoRelativePath || repoRelativePath.startsWith("..")) continue;

      fragmentGithubUrls[tabKey] = getGithubUrlFromRepoPath(repoRelativePath);
    }
  } catch {
    return {};
  }

  return fragmentGithubUrls;
}

export default async function Page(props: PageProps<"/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const fragmentGithubUrls = await getFragmentGithubUrls(page.path);

  return (
    <DocsPage
      toc={[]}
      full={page.data.full}
      tableOfContent={{
        enabled: true,
        component: <TabAwareTOC fallbackItems={page.data.toc ?? []} />,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pt-2 pb-6">
        <LLMCopyButton markdownUrl={`${page.url}.mdx`} />
        <ViewOptions
          markdownUrl={`${page.url}.mdx`}
          githubUrl={getGithubUrl(page.path)}
          fragmentGithubUrls={fragmentGithubUrls}
        />
        <ExpandAllButton />
        <CollapseAllButton />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<"/[[...slug]]">,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
