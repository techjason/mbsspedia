"use client";

import { ChevronDown } from "lucide-react";
import {
  Children,
  type ElementType,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import {
  COLLAPSE_ALL_FRAGMENT_DROPDOWNS_EVENT,
  EXPAND_ALL_FRAGMENT_DROPDOWNS_EVENT,
} from "@/lib/fragment-dropdown-events";

type HeadingProps = {
  children?: ReactNode;
  className?: string;
  id?: string;
};

type SplitSections = {
  introNodes: ReactNode[];
  groupedNodes: ReactNode[][];
};

function isHeadingElement(
  node: ReactNode,
): node is ReactElement<HeadingProps, string> {
  return (
    isValidElement(node) &&
    typeof node.type === "string" &&
    /^h[1-6]$/.test(node.type)
  );
}

function getHeadingTextClass(tagName: string): string {
  switch (tagName) {
    case "h1":
      return "text-[1.85rem] leading-tight font-semibold";
    case "h2":
      return "text-[1.6rem] leading-tight font-semibold";
    case "h3":
      return "text-[1.35rem] leading-tight font-semibold";
    default:
      return "text-[1.15rem] leading-tight font-semibold";
  }
}

function getHeadingLevel(node: ReactNode): number | null {
  if (!isHeadingElement(node)) {
    return null;
  }

  const parsed = Number.parseInt(node.type.slice(1), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function splitByChildHeadingLevel(
  contentNodes: ReactNode[],
  parentHeadingLevel: number,
): SplitSections | null {
  let targetLevel: number | null = null;

  for (const node of contentNodes) {
    const level = getHeadingLevel(node);
    if (level === null || level <= parentHeadingLevel) {
      continue;
    }

    targetLevel = targetLevel === null ? level : Math.min(targetLevel, level);
  }

  if (targetLevel === null) {
    return null;
  }

  const firstHeadingIndex = contentNodes.findIndex(
    (node) => getHeadingLevel(node) === targetLevel,
  );
  if (firstHeadingIndex === -1) {
    return null;
  }

  const headingCount = contentNodes.filter(
    (node) => getHeadingLevel(node) === targetLevel,
  ).length;

  // Avoid splitting for one-off child headings.
  if (headingCount < 2) {
    return null;
  }

  const introNodes = contentNodes.slice(0, firstHeadingIndex);
  const groupedNodes: ReactNode[][] = [];
  let currentGroup: ReactNode[] = [];

  for (const node of contentNodes.slice(firstHeadingIndex)) {
    const level = getHeadingLevel(node);
    if (level === targetLevel && currentGroup.length > 0) {
      groupedNodes.push(currentGroup);
      currentGroup = [node];
      continue;
    }

    currentGroup.push(node);
  }

  if (currentGroup.length > 0) {
    groupedNodes.push(currentGroup);
  }

  return {
    introNodes,
    groupedNodes,
  };
}

function sanitizeHeadingChildren(children: ReactNode): ReactNode {
  const items = Children.toArray(children).flatMap((child) => {
    if (
      isValidElement(child) &&
      typeof child.type === "string" &&
      child.type === "a"
    ) {
      const href = (child.props as { href?: unknown } | null)?.href;
      if (typeof href === "string" && href.startsWith("#")) {
        return Children.toArray(
          (child.props as { children?: ReactNode } | null)?.children,
        );
      }
    }

    return [child];
  });

  if (items.length === 0) {
    return children;
  }

  return items;
}

export function FragmentDropdownSection({
  children,
}: {
  children?: ReactNode;
}) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [open, setOpen] = useState(false);
  const nodes = Children.toArray(children);
  const [headingNode, ...contentNodes] = nodes;
  const hasCollapsibleSection =
    isHeadingElement(headingNode) && contentNodes.length > 0;

  useEffect(() => {
    if (!hasCollapsibleSection) {
      return;
    }

    const syncOpenStateFromHash = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (!hash.length) {
        return;
      }

      const root = sectionRef.current;
      const target = document.getElementById(hash);
      if (root && target && root.contains(target)) {
        setOpen(true);
      }
    };

    syncOpenStateFromHash();
    window.addEventListener("hashchange", syncOpenStateFromHash);

    const expandAllSections = () => {
      setOpen(true);
    };
    const collapseAllSections = () => {
      setOpen(false);
    };
    window.addEventListener(EXPAND_ALL_FRAGMENT_DROPDOWNS_EVENT, expandAllSections);
    window.addEventListener(
      COLLAPSE_ALL_FRAGMENT_DROPDOWNS_EVENT,
      collapseAllSections,
    );

    return () => {
      window.removeEventListener("hashchange", syncOpenStateFromHash);
      window.removeEventListener(
        EXPAND_ALL_FRAGMENT_DROPDOWNS_EVENT,
        expandAllSections,
      );
      window.removeEventListener(
        COLLAPSE_ALL_FRAGMENT_DROPDOWNS_EVENT,
        collapseAllSections,
      );
    };
  }, [hasCollapsibleSection]);

  if (nodes.length === 0) {
    return null;
  }

  if (!hasCollapsibleSection) {
    return <>{children}</>;
  }

  const HeadingTag = headingNode.type as ElementType<HeadingProps>;
  const headingId = headingNode.props.id ?? `${contentId}-heading`;
  const headingChildren = sanitizeHeadingChildren(headingNode.props.children);
  const parentHeadingLevel = getHeadingLevel(headingNode);
  const splitSections =
    parentHeadingLevel === null
      ? null
      : splitByChildHeadingLevel(contentNodes, parentHeadingLevel);

  if (splitSections) {
    return (
      <div ref={sectionRef}>
        <HeadingTag
          id={headingId}
          className={cn(headingNode.props.className, "not-prose my-0 py-2")}
        >
          <span className={getHeadingTextClass(headingNode.type)}>
            {headingChildren}
          </span>
        </HeadingTag>

        {splitSections.introNodes.length > 0 ? (
          <div className="pb-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {splitSections.introNodes}
          </div>
        ) : null}

        <div className="pb-3">
          {splitSections.groupedNodes.map((sectionNodes, index) => {
            const firstNode = sectionNodes[0];
            const key =
              isHeadingElement(firstNode) && firstNode.props.id
                ? firstNode.props.id
                : `${headingId}-sub-${index}`;

            return (
              <FragmentDropdownSection key={key}>
                {sectionNodes}
              </FragmentDropdownSection>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div ref={sectionRef}>
      <HeadingTag
        id={headingId}
        className={cn(headingNode.props.className, "not-prose my-0")}
      >
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="group flex w-full items-center justify-between gap-4 py-2 text-left"
        >
          <span className={getHeadingTextClass(headingNode.type)}>
            {headingChildren}
          </span>
          <ChevronDown
            className={cn(
              "size-6 shrink-0 text-fd-muted-foreground transition-transform duration-200",
              open && "rotate-180",
            )}
          />
        </button>
      </HeadingTag>

      <div
        id={contentId}
        hidden={!open}
        className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      >
        {contentNodes}
      </div>
    </div>
  );
}
