"use client";

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import type { SortedResult } from "fumadocs-core/search/server";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useRef } from "react";

export default function DocsSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const { search, setSearch, query } = useDocsSearch({
    type: "fetch",
    api: "/api/search",
    locale,
    delayMs: 60,
  });

  const currentItems = query.data !== "empty" ? query.data : null;
  const lastItemsRef = useRef<SortedResult[] | null>(null);

  if (currentItems) {
    lastItemsRef.current = currentItems;
  }

  if (!currentItems && search.trim().length === 0) {
    lastItemsRef.current = null;
  }

  const itemsToDisplay =
    currentItems ?? (query.isLoading ? lastItemsRef.current : null);

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        {query.isLoading && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-fd-muted-foreground">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            Searching...
          </div>
        )}
        <SearchDialogList items={itemsToDisplay} />
        {query.error && (
          <div className="px-3 pb-2 text-xs text-red-400">
            Search request failed. Verify <code>MIXEDBREAD_API_KEY</code> and{" "}
            <code>MIXEDBREAD_STORE_IDENTIFIER</code> on the server.
          </div>
        )}
      </SearchDialogContent>
    </SearchDialog>
  );
}
