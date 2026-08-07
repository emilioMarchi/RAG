import { EmbeddingService } from '../src/services/embeddingService.js';
import { LLMService } from '../src/services/llmService.js';
import { IterativeRAGEngine } from '../src/services/iterativeRAGEngine.js';
import { ChunkingService } from '../src/services/chunkingService.js';
import { IngestionPipeline } from '../src/services/ingestionPipeline.js';
import { StorageService } from '../src/services/r2Service.js';
import { pool, query } from '../src/config/db.js';
import * as fs from 'fs';
import * as path from 'path';

async function run() {
  console.log('Inicializando servicios...');
  const embedder = new EmbeddingService();
  const llm = new LLMService();
  const engine = new IterativeRAGEngine(embedder, llm);
  const chunker = new ChunkingService();
  const pipeline = new IngestionPipeline(embedder, llm, new StorageService());

  // 1. Validar si hay documentos, si no, ingestar test-doc.md
  const docsCount = await query('SELECT COUNT(*)::int as count FROM documents');
  if (docsCount.rows[0].count === 0) {
    console.log('La base de datos está vacía. Ingestando test-doc.md...');
    const filePath = path.resolve('test-doc.md');
    if (!fs.existsSync(filePath)) {
      throw new Error(`Archivo no encontrado para ingestar: ${filePath}`);
    }
    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = 'text/markdown';

    const fullContentText = await chunker.extractText(filePath, mimeType);
    const paragraphs = chunker.splitIntoParagraphs(fullContentText);
    console.log(`  Párrafos extraídos: ${paragraphs.length}. Procesando ingesta...`);

    const ingestResult = await pipeline.processAndStoreDocument({
      title: fileName,
      fileBuffer: buffer,
      fileName,
      mimeType,
      fullContentText,
      paragraphs,
    });
    console.log(`  ✓ Documento ingestado exitosamente. ID: ${ingestResult.docId}`);
  } else {
    console.log('La base de datos ya contiene documentos.');
  }

  // 2. Realizar la consulta
  const queryText = "que es cronos? que cifrado se usa para datos?";
  console.log(`\nEjecutando consulta en IterativeRAGEngine: "${queryText}"\n`);
  
  const result = await engine.query(queryText, 5, 3);
  
  console.log('\n--- RESPUESTA FINAL DEL RAG ---');
  console.log(result.answer);
  console.log('\n--- FUENTES RECUPERADAS ---');
  for (const s of result.sources) {
    console.log(`• ${s.doc_title} (idx: ${(s as any).paragraph_index}) — "${s.raw_content.substring(0, 100)}..."`);
  }
  console.log(`\nIteraciones: ${result.iterations}`);
  
  await pool.end();
}

run().catch((err) => {
  console.error('Error durante la prueba:', err);
  process.exit(1);
});
