export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, label = 'operation' } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const isRateLimit =
        error instanceof Error &&
        (error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('Too Many Requests'));

      const delay = isRateLimit
        ? baseDelay * Math.pow(2, attempt) + Math.random() * 1000
        : baseDelay * attempt;

      console.warn(`[${label}] Attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error(`[${label}] All ${maxRetries} attempts failed`);
}
