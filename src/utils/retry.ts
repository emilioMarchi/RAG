export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    /** Delay mínimo (ms) cuando el error es rate-limit (429). Default: 30000 */
    rateLimitDelay?: number;
    label?: string;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    rateLimitDelay = 30_000,
    label = 'operation',
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const isRateLimit =
        error instanceof Error &&
        (error.message.includes('429') ||
          error.message.includes('rate limit') ||
          error.message.includes('Too Many Requests') ||
          error.message.includes('RateLimited'));

      let delay: number;
      if (isRateLimit) {
        // Intentar leer el header Retry-After del servidor
        const serverWait = extractRetryAfter(error as Error);
        // Usar el mayor entre lo que dice el servidor y el mínimo configurado
        const base = serverWait > 0 ? serverWait * 1000 : rateLimitDelay;
        delay = base + Math.random() * 5000;
        console.warn(`[${label}] Attempt ${attempt}/${maxRetries} failed (rate-limit 429). Retrying in ${Math.round(delay / 1000)}s...`);
      } else {
        // Error genérico: backoff exponencial
        delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        const errMsg = error instanceof Error ? error.message.substring(0, 120) : String(error);
        console.warn(`[${label}] Attempt ${attempt}/${maxRetries} failed (${errMsg}). Retrying in ${Math.round(delay)}ms...`);
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error(`[${label}] All ${maxRetries} attempts failed`);
}

function extractRetryAfter(error: Error): number {
  const e = error as { headers?: Record<string, string>; error?: { metadata?: Record<string, unknown> } };
  const header = e?.headers?.['retry-after'] ?? e?.headers?.['Retry-After'];
  const meta = e?.error?.metadata?.retry_after_seconds ?? e?.error?.metadata?.retry_after_seconds_raw;
  const candidate = header ?? meta;
  if (candidate == null) return 0;
  const seconds = typeof candidate === 'number' ? candidate : parseInt(String(candidate), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
