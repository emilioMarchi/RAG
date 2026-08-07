import { env } from '../config/env.js';
import { withRetry } from '../utils/retry.js';

const MODEL = 'gemini-embedding-001';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1';

export class EmbeddingService {
  async generateEmbedding(text: string, dimensions: number = 768): Promise<number[]> {
    return withRetry(
      async () => {
        const url = `${BASE_URL}/models/${MODEL}:embedContent?key=${env.GEMINI_API_KEY}`;
        const body = JSON.stringify({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: dimensions,
        });
        console.log(`[EMBED DEBUG] dim=${dimensions} text.length=${text.length} body=${body.substring(0, 200)}`);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        const data = await response.json();
        console.log(`[EMBED DEBUG] status=${response.status} response=${JSON.stringify(data).substring(0, 300)}`);

        if (!response.ok) {
          throw new Error(data.error?.message || `HTTP ${response.status}`);
        }

        if (!data.embedding?.values) {
          throw new Error('Gemini API returned no embedding values');
        }

        return data.embedding.values;
      },
      { maxRetries: 3, baseDelay: 2000, label: `embedding-${dimensions}d` }
    );
  }
}
