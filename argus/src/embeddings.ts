// ============ Gemini Embedding Generation ============
// Generates 768-dimensional vector embeddings using the native Gemini embedContent API.
// Used for kNN hybrid search in Elasticsearch.
//
// Uses: POST /v1beta/models/{model}:embedContent?key={apiKey}
// with output_dimensionality=768 to normalize output to 768 dims (model default is 3072).
//
// Failures are silent (return null) — embedding failures do NOT trigger
// AI tier downgrade. Events stored without embeddings fall back to BM25-only search.

interface EmbeddingsConfig {
  apiKey: string;
  apiUrl: string;          // e.g. https://generativelanguage.googleapis.com/v1beta/openai
  embeddingModel: string;  // e.g. gemini-embedding-001
}

let config: EmbeddingsConfig | null = null;

// Derive the base Generative Language API URL from the OpenAI-compat URL
// e.g. https://generativelanguage.googleapis.com/v1beta/openai → /v1beta
function getBaseUrl(apiUrl: string): string {
  return apiUrl.replace(/\/openai\/?$/, '');
}

export function initEmbeddings(cfg: EmbeddingsConfig): void {
  config = cfg;
  console.log(`✅ [Embeddings] Initialized: model=${cfg.embeddingModel}`);
}

// ============ Embedding text builder ============

/** Concatenates event fields into a single string for embedding. */
export function buildEventEmbeddingText(event: {
  title: string;
  description?: string | null;
  keywords?: string;
  location?: string | null;
}): string {
  const parts: string[] = [event.title];
  if (event.description) parts.push(event.description);
  if (event.keywords) parts.push(`Keywords: ${event.keywords}`);
  if (event.location) parts.push(`Location: ${event.location}`);
  return parts.join('. ');
}

// ============ Embedding generation ============

/**
 * Generates a 768-dimensional embedding vector for the given text.
 * Uses the native Gemini embedContent API with outputDimensionality=768.
 * Returns null on any failure (network, API error, config missing).
 * Does NOT report to the AI tier manager — embedding failures are silent.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!config) {
    console.warn('[Embeddings] Not initialized — skipping embedding generation');
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const baseUrl = getBaseUrl(config.apiUrl);
    const url = `${baseUrl}/models/${config.embeddingModel}:embedContent?key=${config.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text: trimmed }] },
        output_dimensionality: 768,  // normalize to 768 dims for ES dense_vector
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Embeddings] API error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      embedding?: { values?: number[] };
    };

    const values = data?.embedding?.values;
    if (!values || !Array.isArray(values) || values.length === 0) {
      console.warn('[Embeddings] Unexpected response shape — no values returned');
      return null;
    }

    return values;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Embeddings] generateEmbedding failed: ${msg}`);
    return null;
  }
}
