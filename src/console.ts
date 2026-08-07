import { createInterface } from 'readline';
import { EmbeddingService } from './services/embeddingService.js';
import { LLMService } from './services/llmService.js';
import { R2StorageService } from './services/r2Service.js';
import { ChunkingService } from './services/chunkingService.js';
import { IngestionPipeline } from './services/ingestionPipeline.js';
import { HierarchicalRAGModule } from './services/ragEngine.js';
import { IterativeRAGEngine } from './services/iterativeRAGEngine.js';
import { query } from './config/db.js';

const embedder = new EmbeddingService();
const llm = new LLMService();
const rag = new HierarchicalRAGModule(embedder, llm);
const iterativeRag = new IterativeRAGEngine(embedder, llm);
const pipeline = new IngestionPipeline(embedder, llm, new R2StorageService());
const chunker = new ChunkingService();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '',
});

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════╗
║        RAG Console - Consultas               ║
╠══════════════════════════════════════════════╣
║  /help        - Muestra esta ayuda           ║
║  /docs        - Lista documentos             ║
║  /ingest <ruta> - Ingesta un archivo         ║
║  /topDocs <n>  - Cambia topDocs (default: 5) ║
║  /topPars <n>  - Cambia topParagraphs (def:3)║
║  /iterative    - Alterna modo iterativo ON/OFF║
║  /showconfig   - Muestra config actual       ║
║  /exit o Ctrl+C - Salir                      ║
║                                              ║
║  Cualquier otro texto se envía como consulta ║
╚══════════════════════════════════════════════╝
`);
}

async function listDocuments() {
  const result = await query<{ id: string; title: string; mime_type: string; created_at: string }>(
    'SELECT id, title, mime_type, created_at FROM documents ORDER BY created_at DESC'
  );
  if (result.rows.length === 0) {
    console.log('No hay documentos ingestados.');
    return;
  }
  console.log('\nDocumentos:');
  for (const doc of result.rows) {
    console.log(`  ${doc.id.substring(0, 8)}... | ${doc.title} | ${doc.mime_type} | ${doc.created_at}`);
  }
}

async function ingestFile(filePath: string) {
  try {
    const fs = await import('fs');
    const path = await import('path');
    if (!fs.existsSync(filePath)) {
      console.log(`Archivo no encontrado: ${filePath}`);
      return;
    }
    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    console.log(`Ingestando: ${fileName}...`);
    const fullContentText = await chunker.extractText(filePath, mimeType);
    const paragraphs = chunker.splitIntoParagraphs(fullContentText);
    console.log(`  Párrafos extraídos: ${paragraphs.length}`);

    const result = await pipeline.processAndStoreDocument({
      title: fileName,
      fileBuffer: buffer,
      fileName,
      mimeType,
      fullContentText,
      paragraphs,
    });

    console.log(`  ✓ Ingestado: ${result.docId} (${result.paragraphsProcessed} párrafos)`);
  } catch (err) {
    console.error('Error en ingesta:', err instanceof Error ? err.message : err);
  }
}

let topDocs = 5;
let topParagraphs = 3;
let iterativeMode = false;

async function handleQuery(input: string) {
  console.log('\n🔍 Consultando...');
  try {
    if (iterativeMode) {
      const result = await iterativeRag.query(input.trim(), topDocs, topParagraphs);
      console.log(`\n${result.answer}\n`);
      console.log(`(iteraciones: ${result.iterations})`);
      if (result.sources.length > 0) {
        console.log('Fuentes:');
        for (const s of result.sources) {
          console.log(`  • ${s.doc_title} — "${s.raw_content.substring(0, 100)}..."`);
        }
      }
    } else {
      const result = await rag.query(input.trim(), topDocs, topParagraphs);
      console.log(`\n${result.answer}\n`);
      if (result.sources.length > 0) {
        console.log('Fuentes:');
        for (const s of result.sources) {
          const docLabel = s.doc_title || 'sin título';
          console.log(`  • ${s.doc_title} — "${s.raw_content.substring(0, 100)}..."`);
        }
      }
    }
  } catch (err) {
    console.error('Error en consulta:', err instanceof Error ? err.message : err);
  }
}

async function main() {
  console.log('🔷 RAG Console — Hierarchical Contextual RAG');
  printHelp();

  const ask = () => {
    rl.question('\n❯ ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        ask();
        return;
      }

      if (trimmed === '/exit') {
        rl.close();
        return;
      }
      if (trimmed === '/help') {
        printHelp();
        ask();
        return;
      }
      if (trimmed === '/docs') {
        await listDocuments();
        ask();
        return;
      }
      if (trimmed === '/showconfig') {
        console.log(`  topDocs=${topDocs}, topParagraphs=${topParagraphs}`);
        ask();
        return;
      }
      if (trimmed.startsWith('/topDocs ')) {
        const n = parseInt(trimmed.split(' ')[1], 10);
        if (!isNaN(n) && n > 0) topDocs = n;
        console.log(`  topDocs = ${topDocs}`);
        ask();
        return;
      }
      if (trimmed.startsWith('/topPars ')) {
        const n = parseInt(trimmed.split(' ')[1], 10);
        if (!isNaN(n) && n > 0) topParagraphs = n;
        console.log(`  topParagraphs = ${topParagraphs}`);
        ask();
        return;
      }
      if (trimmed.startsWith('/ingest ')) {
        const filePath = trimmed.slice('/ingest '.length).trim();
        await ingestFile(filePath);
        ask();
        return;
      }
      if (trimmed === '/iterative') {
        iterativeMode = !iterativeMode;
        console.log(`  Modo iterativo: ${iterativeMode ? 'ON' : 'OFF'}`);
        ask();
        return;
      }

      await handleQuery(trimmed);
      ask();
    });
  };

  ask();
}

process.on('SIGINT', () => {
  console.log('\nbye.');
  rl.close();
  process.exit(0);
});

main();
