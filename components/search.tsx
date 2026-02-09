"use client";

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useDocsSearch } from "fumadocs-core/search/client";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { OramaClient } from "@oramacloud/client";
import { useMemo, useState } from "react";

const oramaEndpoint =
  process.env.NEXT_PUBLIC_ORAMA_ENDPOINT ??
  process.env.NEXT_PUBLIC_ORAMA_API_ENDPOINT;
const oramaPublicApiKey = process.env.NEXT_PUBLIC_ORAMA_API_KEY;
const cloudConfigured = Boolean(oramaEndpoint && oramaPublicApiKey);

export default function DocsSearchDialog(props: SharedProps) {
  if (!cloudConfigured) {
    return <MissingConfigSearchDialog {...props} />;
  }

  return <OramaCloudSearchDialog {...props} />;
}

function OramaCloudSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const client = useMemo(
    () =>
      new OramaClient({
        endpoint: oramaEndpoint!,
        api_key: oramaPublicApiKey!,
      }),
    [],
  );

  const { search, setSearch, query } = useDocsSearch({
    type: "orama-cloud-legacy",
    client,
    locale,
  });

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
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
        {query.error && (
          <div className="px-3 pb-2 text-xs text-red-400">
            Search request failed. Verify Orama endpoint and public API key.
          </div>
        )}
        <SearchDialogFooter>
          <a
            href="https://orama.com"
            rel="noreferrer noopener"
            className="ms-auto text-xs text-fd-muted-foreground"
          >
            Search powered by Orama
          </a>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}

function MissingConfigSearchDialog(props: SharedProps) {
  const [search, setSearch] = useState("");

  return (
    <SearchDialog
      search={search}
      onSearchChange={setSearch}
      isLoading={false}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <div className="p-3 text-sm text-fd-muted-foreground">
          Search is not configured. Set <code>NEXT_PUBLIC_ORAMA_ENDPOINT</code>{" "}
          (or <code>NEXT_PUBLIC_ORAMA_API_ENDPOINT</code>) and{" "}
          <code>NEXT_PUBLIC_ORAMA_API_KEY</code>.
        </div>
      </SearchDialogContent>
    </SearchDialog>
  );
}
