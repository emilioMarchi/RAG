import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  GEMINI_API_KEY: required('GEMINI_API_KEY'),
  LLM_API_URL: process.env.LLM_API_URL || 'https://openrouter.ai/api/v1',
  LLM_API_KEY: required('LLM_API_KEY'),
  LLM_MODEL: process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  DATABASE_URL: required('DATABASE_URL'),
  CLOUDFLARE_ACCOUNT_ID: required('CLOUDFLARE_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: required('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: required('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET_NAME: required('R2_BUCKET_NAME'),
  R2_PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN || null,
  PORT: parseInt(process.env.PORT || '3000', 10),
} as const;
