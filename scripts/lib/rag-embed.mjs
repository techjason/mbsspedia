import { embed, embedMany } from "ai";

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-large";

export async function embedSingleValue({ model = DEFAULT_EMBEDDING_MODEL, value }) {
  const { embedding, usage } = await embed({
    model,
    value,
    maxRetries: 2,
  });

  return { embedding, usage };
}

export async function embedValues({
  model = DEFAULT_EMBEDDING_MODEL,
  values,
  maxParallelCalls = 4,
}) {
  if (!Array.isArray(values) || values.length === 0) {
    return { embeddings: [], usage: undefined };
  }

  const { embeddings, usage } = await embedMany({
    model,
    values,
    maxParallelCalls,
    maxRetries: 2,
  });

  return { embeddings, usage };
}
