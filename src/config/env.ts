import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string): string | undefined {
  return process.env[key] || undefined;
}

export const env = {
  GEMINI_API_KEY: required('GEMINI_API_KEY'),
  LLM_API_URL: process.env.LLM_API_URL || 'https://openrouter.ai/api/v1',
  LLM_API_KEY: required('LLM_API_KEY'),
  LLM_MODEL: process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  LLM_BACKUP_MODEL: optional('LLM_BACKUP_MODEL'),
  DATABASE_URL: required('DATABASE_URL'),

  // Almacenamiento: 'local' (default) o 'r2'
  STORAGE_MODE: (process.env.STORAGE_MODE || 'local') as 'local' | 'r2',
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR || 'data/documents',
  // R2 es opcional: solo se usa si STORAGE_MODE=r2
  CLOUDFLARE_ACCOUNT_ID: optional('CLOUDFLARE_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: optional('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: optional('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET_NAME: optional('R2_BUCKET_NAME'),
  R2_PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN || null,
  PORT: parseInt(process.env.PORT || '3000', 10),
} as const;
