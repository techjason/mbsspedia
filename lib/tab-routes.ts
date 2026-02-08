const TAB_SECTIONS = [
  "etiology",
  "ddx",
  "dx",
  "mx",
  "complications",
] as const;

export const TAB_ROUTE_CONFIG: Record<string, readonly string[]> = {
  "general-surgery/jaundice": TAB_SECTIONS,
  "general-surgery/liver-abscess": TAB_SECTIONS,
  "general-surgery/liver-cirrhosis": TAB_SECTIONS,
};

export function getTabSectionsForSlug(slug?: string[]): readonly string[] | undefined {
  if (!Array.isArray(slug) || slug.length === 0) return undefined;
  return TAB_ROUTE_CONFIG[slug.join("/")];
}
