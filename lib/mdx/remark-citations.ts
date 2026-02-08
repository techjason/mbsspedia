type UnknownNode = {
  type: string;
  value?: string;
  depth?: number;
  name?: string;
  attributes?: unknown[];
  children?: UnknownNode[];
};

type ReferenceItem = {
  n: number;
  source: string;
};

type RootNode = UnknownNode & {
  type: "root";
  children: UnknownNode[];
};

function hasChildren(node: UnknownNode): node is UnknownNode & { children: UnknownNode[] } {
  return Array.isArray(node.children);
}

function getNodeText(node: UnknownNode): string {
  if (node.type === "text" && typeof node.value === "string") {
    return node.value;
  }

  if (!hasChildren(node)) {
    return "";
  }

  return node.children.map(getNodeText).join("");
}

function isReferencesHeading(node: UnknownNode): boolean {
  if (node.type !== "heading" || node.depth !== 2 || !hasChildren(node)) {
    return false;
  }

  return getNodeText(node).trim().toLowerCase() === "references";
}

function parseReferenceLine(line: string): ReferenceItem | null {
  const match = line
    .trim()
    .match(/^(?:[-*+]\s*)?(?:\d+\.\s*)?\[(\d+)\]\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }

  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n)) {
    return null;
  }

  return {
    n,
    source: match[2].trim(),
  };
}

function parseReferenceItems(listNode: UnknownNode): ReferenceItem[] {
  if (listNode.type !== "list" || !hasChildren(listNode)) {
    return [];
  }

  const items: ReferenceItem[] = [];
  for (const itemNode of listNode.children) {
    if (!hasChildren(itemNode)) {
      continue;
    }

    const text = itemNode.children.map(getNodeText).join(" ").replace(/\s+/g, " ").trim();
    const parsed = parseReferenceLine(text);
    if (!parsed) {
      continue;
    }
    items.push(parsed);
  }

  return items;
}

function replaceReferencesSections(tree: RootNode): void {
  const nextChildren: UnknownNode[] = [];
  let i = 0;

  while (i < tree.children.length) {
    const current = tree.children[i];
    const next = tree.children[i + 1];

    if (isReferencesHeading(current) && next && next.type === "list") {
      const items = parseReferenceItems(next);
      const node: UnknownNode = {
        type: "mdxJsxFlowElement",
        name: "References",
        attributes: [
          {
            type: "mdxJsxAttribute",
            name: "items",
            value: {
              type: "mdxJsxAttributeValueExpression",
              value: JSON.stringify(items),
            },
          },
        ],
        children: [],
      };

      nextChildren.push(node);
      i += 2;
      continue;
    }

    nextChildren.push(current);
    i += 1;
  }

  tree.children = nextChildren;
}

const SKIP_REWRITE_IN_PARENT = new Set([
  "link",
  "linkReference",
  "definition",
  "inlineCode",
  "code",
]);

const SKIP_DESCEND = new Set(["inlineCode", "code", "mdxjsEsm"]);

function splitTextWithCitations(value: string): UnknownNode[] {
  const nodes: UnknownNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(/\[(\d+)\]/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (start > cursor) {
      nodes.push({
        type: "text",
        value: value.slice(cursor, start),
      });
    }

    nodes.push({
      type: "mdxJsxTextElement",
      name: "Cite",
      attributes: [
        {
          type: "mdxJsxAttribute",
          name: "n",
          value: match[1],
        },
      ],
      children: [],
    });

    cursor = end;
  }

  if (cursor < value.length) {
    nodes.push({
      type: "text",
      value: value.slice(cursor),
    });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

function rewriteInlineCitations(node: UnknownNode): void {
  if (!hasChildren(node)) {
    return;
  }

  const nextChildren: UnknownNode[] = [];

  for (const child of node.children) {
    if (
      child.type === "text" &&
      typeof child.value === "string" &&
      !SKIP_REWRITE_IN_PARENT.has(node.type)
    ) {
      nextChildren.push(...splitTextWithCitations(child.value));
    } else {
      nextChildren.push(child);
      if (!SKIP_DESCEND.has(child.type)) {
        rewriteInlineCitations(child);
      }
    }
  }

  node.children = nextChildren;
}

export function remarkCitations() {
  return (tree: UnknownNode) => {
    if (tree.type !== "root" || !hasChildren(tree)) {
      return;
    }

    replaceReferencesSections(tree as RootNode);
    rewriteInlineCitations(tree);
  };
}
