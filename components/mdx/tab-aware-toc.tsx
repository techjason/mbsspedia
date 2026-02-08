"use client";

import {
  PageTOCPopover,
  PageTOCPopoverContent,
  PageTOCPopoverTrigger,
} from "@/components/layout/notebook/page/client";
import { TOCItems } from "@/components/toc/default";
import { TOCProvider, TOCScrollArea } from "@/components/toc";
import type { TOCItemType } from "fumadocs-core/toc";
import { Text } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function getHeadingTitle(heading: Element): string {
  return heading.textContent?.trim() ?? "";
}

function getHeadingId(heading: Element, usedIds: Set<string>): string {
  const currentId = heading.getAttribute("id");
  if (currentId) {
    usedIds.add(currentId);
    return currentId;
  }

  const baseId = slugify(getHeadingTitle(heading)) || "section";
  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  heading.setAttribute("id", candidate);
  usedIds.add(candidate);
  return candidate;
}

function getDepth(heading: Element): number {
  const parsed = Number.parseInt(heading.tagName.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 2;
}

function readActiveTabToc(): TOCItemType[] | null {
  const pageRoot = document.getElementById("nd-page");
  if (!pageRoot) return null;

  const panel = pageRoot.querySelector<HTMLElement>(
    '[role="tabpanel"][data-state="active"]',
  );
  if (!panel) return null;

  const headings = panel.querySelectorAll("h1, h2, h3, h4, h5, h6");
  const usedIds = new Set<string>();
  const items: TOCItemType[] = [];

  headings.forEach((heading) => {
    const title = getHeadingTitle(heading);
    if (!title) return;

    items.push({
      url: `#${getHeadingId(heading, usedIds)}`,
      depth: getDepth(heading),
      title,
    });
  });

  return items;
}

interface TabAwareTOCProps {
  fallbackItems?: readonly TOCItemType[];
}

export function TabAwareTOC({ fallbackItems = [] }: TabAwareTOCProps) {
  const pathname = usePathname();
  const [items, setItems] = useState<TOCItemType[]>([...fallbackItems]);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      frame = window.requestAnimationFrame(() => {
        const tabItems = readActiveTabToc();
        setItems(tabItems ?? [...fallbackItems]);
      });
    };

    update();

    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "id"],
    });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [fallbackItems, pathname]);

  return (
    <TOCProvider toc={items}>
      <div
        id="nd-toc"
        className="sticky top-(--fd-docs-row-3) [grid-area:toc] h-[calc(var(--fd-docs-height)-var(--fd-docs-row-3))] flex flex-col w-(--fd-toc-width) pt-12 pe-4 pb-2 xl:layout:[--fd-toc-width:268px] max-xl:hidden"
      >
        <h3
          id="toc-title"
          className="inline-flex items-center gap-1.5 text-sm text-fd-muted-foreground"
        >
          <Text className="size-4" />
          On this page
        </h3>
        <TOCScrollArea className="mt-3 pe-1">
          <TOCItems />
        </TOCScrollArea>
      </div>

      <PageTOCPopover>
        <PageTOCPopoverTrigger />
        <PageTOCPopoverContent>
          <TOCScrollArea className="pt-0">
            <TOCItems />
          </TOCScrollArea>
        </PageTOCPopoverContent>
      </PageTOCPopover>
    </TOCProvider>
  );
}
