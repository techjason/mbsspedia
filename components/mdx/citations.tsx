type CiteProps = {
  n: number | string;
};

export type ReferenceItem = {
  n: number;
  source: string;
};

type ReferencesProps = {
  items?: ReferenceItem[] | string;
};

function toCitationNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return parsed;
}

function normalizeReferenceItems(items: ReferencesProps["items"]): ReferenceItem[] {
  if (!items) {
    return [];
  }

  const raw =
    typeof items === "string"
      ? (() => {
          try {
            return JSON.parse(items);
          } catch {
            return [];
          }
        })()
      : items;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const n = Number.parseInt(String((item as { n?: unknown }).n ?? ""), 10);
      const source = String((item as { source?: unknown }).source ?? "").trim();
      if (!Number.isFinite(n) || n < 1 || !source) {
        return null;
      }

      return { n, source };
    })
    .filter((item): item is ReferenceItem => item !== null)
    .sort((a, b) => a.n - b.n);
}

export function Cite({ n }: CiteProps) {
  const number = toCitationNumber(n);

  return (
    <sup className="citation-sup">
      <a
        href={`#ref-${number}`}
        className="citation-link"
        aria-label={`Jump to reference ${number}`}
      >
        [{number}]
      </a>
    </sup>
  );
}

export function References({ items }: ReferencesProps) {
  const normalizedItems = normalizeReferenceItems(items);
  if (normalizedItems.length === 0) {
    return null;
  }

  return (
    <section className="citation-references" aria-label="References">
      <h2>References</h2>
      <ol className="citation-list">
        {normalizedItems.map((item) => (
          <li key={`${item.n}-${item.source}`} id={`ref-${item.n}`} className="citation-item">
            <span className="citation-marker">[{item.n}]</span>{" "}
            <span className="citation-source">{item.source}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

