import { pool } from './config/db.js';
import { env } from './config/env.js';
import { LocalEmbeddingService } from './services/localEmbeddingService.js';
import { EmbeddingService } from './services/embeddingService.js';

/**
 * Benchmark comparativo de embeddings: local (384d ONNX) vs Gemini (1536d API).
 *
 * Uso:
 *   npm run eval:embeddings                      # solo local (no llama a Gemini)
 *   npm run eval:embeddings -- --gemini          # compara contra Gemini (GEMINI_API_KEY requerida)
 *   npm run eval:embeddings -- --queries archivo # queries desde un archivo (1 por línea)
 *
 * Mide por query:
 *   - Latencia de embedding (local vs Gemini)
 *   - Top-5/Top-10 por similitud coseno en memoria (mismo corpus de chunks)
 *   - Overlap@5 y overlap@10 entre local y Gemini
 */

const QUERIES_DEFAULT = [
  'puntos del artículo 2',
  '¿qué dice el artículo 29?',
  'plazo para interponer un recurso',
  'cuáles son los requisitos de la demanda laboral',
  'improcedencia del recurso de amparo',
];

const CORPUS_LIMIT = Number(process.env.EVAL_CORPUS_LIMIT || '100');
const TOP_K = [5, 10];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function topK(scores: number[], k: number): number[] {
  return scores
    .map((s, i) => [s, i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, i]) => i);
}

function overlap(a: number[], b: number[]): number {
  const set = new Set(b);
  return a.filter((x) => set.has(x)).length;
}

async function main() {
  const args = process.argv.slice(2);
  const withGemini = args.includes('--gemini');
  const queriesFile = args[args.indexOf('--queries') + 1];
  const queries = queriesFile ? undefined : QUERIES_DEFAULT;

  // 1. Cargar corpus de chunks desde la DB (sin importar la dimensión actual).
  const corpusRes = await pool.query<{ id: string; title: string; contextualized_text: string }>(
    `SELECT p.id, d.title, p.contextualized_text
     FROM document_paragraphs p
     JOIN documents d ON p.document_id = d.id
     ORDER BY d.title, p.paragraph_index
     LIMIT $1`,
    [CORPUS_LIMIT]
  );
  if (corpusRes.rows.length === 0) {
    console.error('No hay párrafos en la DB para evaluar. Ingesta primero un documento.');
    await pool.end();
    process.exit(1);
  }
  const corpus = corpusRes.rows;
  const corpusTexts = corpus.map((c) => c.contextualized_text);

  // 2. Cargar queries.
  const testQueries = queries ??
    (await import('fs')).readFileSync(queriesFile!, 'utf-8').split(/\r?\n/).filter(Boolean);
  if (testQueries.length === 0) {
    console.error('No hay queries para evaluar.');
    await pool.end();
    process.exit(1);
  }

  console.log(`Corpus: ${corpus.length} chunks | Queries: ${testQueries.length} | Gemini: ${withGemini}`);

  // 3. Embeddings locales del corpus (una sola pasada por lote).
  const local = new LocalEmbeddingService(env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS);
  const tLoad = performance.now();
  const corpusLocal = await local.generateEmbeddings(corpusTexts, 16);
  console.log(`[local] load corpus: ${(performance.now() - tLoad).toFixed(0)}ms`);

  // 4. (Opcional) Embeddings Gemini del corpus.
  let gemini: EmbeddingService | null = null;
  let corpusGemini: number[][] | null = null;
  if (withGemini) {
    gemini = new EmbeddingService();
    const g = await gemini.generateEmbedding(corpusTexts[0], 1536);
    console.log(`[gemini] dims corpus: ${g.length}`);
    corpusGemini = [];
    for (let i = 0; i < corpusTexts.length; i++) {
      corpusGemini.push(await gemini.generateEmbedding(corpusTexts[i], 1536));
      if ((i + 1) % 20 === 0) console.log(`[gemini] corpus ${i + 1}/${corpusTexts.length}`);
    }
  }

  // 5. Evaluar cada query.
  for (const q of testQueries) {
    console.log(`\n=== Query: "${q}" ===`);

    const t0 = performance.now();
    const qLocal = await local.generateEmbedding(q);
    const localMs = performance.now() - t0;
    const localScores = corpusLocal.map((v) => cosine(qLocal, v));
    const localTop5 = topK(localScores, TOP_K[0]);

    if (!corpusGemini || !gemini) {
      console.log(`[local] embed: ${localMs.toFixed(0)}ms | dims=${qLocal.length}`);
      console.log(`[local] top5: ${localTop5.map((i) => corpus[i].title.slice(0, 40) + '#' + i).join(' | ')}`);
      continue;
    }

    const t1 = performance.now();
    const qGemini = await gemini.generateEmbedding(q, 1536);
    const geminiMs = performance.now() - t1;
    const geminiScores = corpusGemini.map((v) => cosine(qGemini, v));
    const geminiTop5 = topK(geminiScores, TOP_K[0]);

    console.log(`[local]  embed: ${localMs.toFixed(0)}ms | dims=${qLocal.length}`);
    console.log(`[gemini] embed: ${geminiMs.toFixed(0)}ms | dims=${qGemini.length}`);
    console.log(`[local]  top5: ${localTop5.join(',')}`);
    console.log(`[gemini] top5: ${geminiTop5.join(',')}`);
    for (const k of TOP_K) {
      const o = overlap(topK(localScores, k), topK(geminiScores, k));
      console.log(`[overlap@${k}] ${o} de ${k} (${((o / k) * 100).toFixed(0)}%)`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});