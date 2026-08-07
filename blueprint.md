🚀 Spec Completo: Módulo RAG Hierárquico, Contextual y R2
(Resumen final listo para copiar y pegar a tu agente de desarrollo)

📌 Arquitectura del Sistema
[Cliente] ──► Subir Archivo ──► Cloudflare R2 (Guarda Binario original)
                    │
                    ▼
       [Ingestion Pipeline]
         ├─ OpenCode API (LLM Free)  ──► Contextualiza Chunks + Genera Metadata JSONB
         └─ Gemini API (Embeddings)  ──► Genera Vector 768d (Doc) y Vector 1536d (Chunk Contextualizado)
                    │
                    ▼
          [PostgreSQL + pgvector] (Guarda URLs de R2, Embeddings y Metadata)

-----------------------------------------------------------------------------------------

[User Query] ──► Gemini API (Embeddings: 768d y 1536d)
                    │
                    ▼
          [Búsqueda Jerárquica en Postgres]
         ├─ Capa 1: Filtra TOPDocs candidatos por similitud en 768d
         └─ Capa 2: Filtra TOPChunks precisos por similitud en 1536d
                    │
                    ▼
          [OpenCode API (LLM Free)] ──► Genera la respuesta final usando el contexto recuperado
🛠️ Tech Stack
Runtime / Lenguaje: Node.js, TypeScript (tsx).

Base de Datos & Vectores: PostgreSQL + Extensión pgvector (índices HNSW y GIN).

Storage de Archivos: Cloudflare R2 (@aws-sdk/client-s3).

Embeddings (Único uso de Google): Gemini API via @google/genai (text-embedding-004).

LLM Principal (Ingestión y RAG Query): OpenCode API (via @openai/openai con modelos abiertos gratis como meta-llama/llama-3.3-70b-instruct:free o similar).

🗄️ Base de Datos: schema.sql
SQL
-- 1. Habilitar extensión vectorial
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Tabla de Documentos (Capa 1 - Filtro General 768d + R2 Storage)
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  r2_key TEXT NOT NULL,          -- Clave de objeto en R2 (ej: "docs/1721000-manual.pdf")
  r2_url TEXT,                   -- URL de acceso directo/público (opcional)
  mime_type VARCHAR(100),
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding_base vector(768) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Tabla de Párrafos / Chunks Enriquecidos (Capa 2 - Filtro Profundo 1536d)
CREATE TABLE document_paragraphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_index INT NOT NULL,
  raw_content TEXT NOT NULL,
  contextualized_text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding_high vector(1536) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Índices para rendimiento
CREATE INDEX idx_docs_base ON documents USING hnsw (embedding_base vector_cosine_ops);
CREATE INDEX idx_paragraphs_high ON document_paragraphs USING hnsw (embedding_high vector_cosine_ops);
CREATE INDEX idx_paragraphs_meta ON document_paragraphs USING gin (metadata);
🔑 Variables de Entorno (.env)
Fragmento de código
# Gemini (ÚNICAMENTE EMBEDDINGS)
GEMINI_API_KEY=tu_gemini_api_key

# OpenCode API (LLM GENERAL / MODELOS FREE)
OPENCODE_API_URL=https://openrouter.ai/api/v1
OPENCODE_API_KEY=tu_opencode_key
OPENCODE_MODEL=meta-llama/llama-3.3-70b-instruct:free

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/rag_db

# Cloudflare R2 Storage
CLOUDFLARE_ACCOUNT_ID=tu_account_id
R2_ACCESS_KEY_ID=tu_access_key
R2_SECRET_ACCESS_KEY=tu_secret_key
R2_BUCKET_NAME=tu_bucket_r2
R2_PUBLIC_DOMAIN=https://pub-xxxx.r2.dev
💻 Código del Proyecto (TypeScript)
1. Conexión a Base de Datos (src/config/db.ts)
TypeScript
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
});
2. Servicio de Storage Cloudflare R2 (src/services/r2Service.ts)
TypeScript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class R2StorageService {
  private s3Client: S3Client;
  private bucketName: string;

  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;
    this.bucketName = process.env.R2_BUCKET_NAME!;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }

  async uploadFile(fileBuffer: Buffer, fileName: string, mimeType: string) {
    const key = `documents/${Date.now()}-${fileName}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
      })
    );

    return {
      r2Key: key,
      publicUrl: process.env.R2_PUBLIC_DOMAIN 
        ? `${process.env.R2_PUBLIC_DOMAIN}/${key}`
        : null,
    };
  }

  async getDownloadUrl(r2Key: string, expiresInSeconds = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: r2Key,
    });
    return await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
  }
}
3. Servicio Único de Embeddings con Gemini (src/services/embeddingService.ts)
TypeScript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export class EmbeddingService {
  private modelName = 'text-embedding-004';

  /**
   * Genera vectores numéricos con Gemini ajustando la dimensión (768d o 1536d)
   */
  async generateEmbedding(text: string, dimensions: number = 768): Promise<number[]> {
    const response = await ai.models.embedContent({
      model: this.modelName,
      contents: text,
      config: { outputDimensionality: dimensions },
    });

    if (!response.embedding?.values) {
      throw new Error('Error al generar el embedding en Gemini API');
    }

    return response.embedding.values;
  }
}
4. Servicio LLM via OpenCode (src/services/openCodeService.ts)
TypeScript
import OpenAI from 'openai';

const openCode = new OpenAI({
  baseURL: process.env.OPENCODE_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENCODE_API_KEY,
});

export class OpenCodeService {
  private defaultModel: string;

  constructor() {
    this.defaultModel = process.env.OPENCODE_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
  }

  /**
   * Genera contextualización y metadata de chunks en formato JSON para la Ingestión
   */
  async enrichChunk(documentTitle: string, docSummary: string, chunkText: string) {
    const prompt = `
Eres un asistente especializado en preparar datos para RAG.
Analiza el siguiente fragmento dentro del contexto del documento general.

DOCUMENTO: "${documentTitle}"
RESUMEN GENERAL: "${docSummary}"
FRAGMENTO: "${chunkText}"

Devuelve STRICTAMENTE un JSON con el siguiente formato:
{
  "contextualized_text": "[Antepone un contexto de 1 oracion que ubique al fragmento en el documento] - Fragmento: ${chunkText}",
  "keywords": ["tag1", "tag2"],
  "category": "Nombre de categoría principal"
}
`;

    const response = await openCode.chat.completions.create({
      model: this.defaultModel,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error('Falló el enriquecimiento con OpenCode API');

    return JSON.parse(content) as {
      contextualized_text: string;
      keywords: string[];
      category: string;
    };
  }

  /**
   * Genera la respuesta final del RAG al usuario usando modelos abiertos gratis
   */
  async generateRAGAnswer(userQuery: string, contextText: string): Promise<string> {
    const systemPrompt = `
Eres un asistente preciso y directo. Responde a la pregunta del usuario utilizando EXCLUSIVAMENTE la información provista en el CONTEXTO. 
Si la respuesta no está en el contexto, indica amablemente que no dispones de esa información.

--- CONTEXTO RECUPERADO ---
${contextText}
---------------------------
`;

    const response = await openCode.chat.completions.create({
      model: this.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery },
      ],
      temperature: 0.2,
    });

    return response.choices[0].message.content || 'Sin respuesta generada.';
  }
}
5. Pipeline de Ingestación (src/services/ingestionPipeline.ts)
TypeScript
import { Client } from 'pg';
import { EmbeddingService } from './embeddingService';
import { OpenCodeService } from './openCodeService';
import { R2StorageService } from './r2Service';

export class IngestionPipeline {
  constructor(
    private pg: Client,
    private embedder: EmbeddingService,
    private llm: OpenCodeService,
    private storage: R2StorageService
  ) {}

  async processAndStoreDocument(params: {
    title: string;
    fileBuffer: Buffer;
    fileName: string;
    mimeType: string;
    fullContentText: string;
    paragraphs: string[];
  }) {
    const { title, fileBuffer, fileName, mimeType, fullContentText, paragraphs } = params;

    // 1. Guardar archivo binario en Cloudflare R2
    const uploadResult = await this.storage.uploadFile(fileBuffer, fileName, mimeType);

    // 2. Vector Base 768d para todo el documento con Gemini
    const baseVector = await this.embedder.generateEmbedding(fullContentText, 768);

    // 3. Persistir Documento principal vinculando r2_key
    const docRes = await this.pg.query(
      `INSERT INTO documents (title, content, r2_key, r2_url, mime_type, embedding_base) 
       VALUES ($1, $2, $3, $4, $5, $6::vector) RETURNING id`,
      [title, fullContentText, uploadResult.r2Key, uploadResult.publicUrl, mimeType, JSON.stringify(baseVector)]
    );
    const docId = docRes.rows[0].id;

    const docSummary = fullContentText.substring(0, 300) + '...';

    // 4. Enriquecer con OpenCode y Vectorizar a 1536d con Gemini cada párrafo
    for (let i = 0; i < paragraphs.length; i++) {
      const rawText = paragraphs[i];

      // A. OpenCode enriquece texto y extrae metadata
      const enriched = await this.llm.enrichChunk(title, docSummary, rawText);

      // B. Gemini crea vector 1536d sobre el texto contextualizado
      const highVector = await this.embedder.generateEmbedding(enriched.contextualized_text, 1536);

      // C. Guardar Párrafo en DB
      await this.pg.query(
        `INSERT INTO document_paragraphs 
         (document_id, paragraph_index, raw_content, contextualized_text, metadata, embedding_high)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)`,
        [
          docId,
          i,
          rawText,
          enriched.contextualized_text,
          JSON.stringify({ keywords: enriched.keywords, category: enriched.category }),
          JSON.stringify(highVector),
        ]
      );
    }

    return { docId, r2Key: uploadResult.r2Key, paragraphsProcessed: paragraphs.length };
  }
}
6. Motor RAG Jerárquico (src/services/ragEngine.ts)
TypeScript
import { Client } from 'pg';
import { EmbeddingService } from './embeddingService';
import { OpenCodeService } from './openCodeService';

export class HierarchicalRAGModule {
  constructor(
    private pg: Client,
    private embedder: EmbeddingService,
    private llm: OpenCodeService
  ) {}

  async query(userQuery: string, topDocs = 5, topParagraphs = 3) {
    // --- CAPA 1: Búsqueda de documentos con Gemini Embedding 768d ---
    const baseQueryVector = await this.embedder.generateEmbedding(userQuery, 768);

    const candidateDocsRes = await this.pg.query(
      `SELECT id, title, r2_key, r2_url FROM documents
       ORDER BY embedding_base <=> $1::vector LIMIT $2`,
      [JSON.stringify(baseQueryVector), topDocs]
    );

    const candidateIds = candidateDocsRes.rows.map((row) => row.id);
    if (candidateIds.length === 0) {
      return { answer: 'No se encontraron documentos candidatos.', sources: [] };
    }

    // --- CAPA 2: Búsqueda profunda en párrafos con Gemini Embedding 1536d ---
    const highQueryVector = await this.embedder.generateEmbedding(userQuery, 1536);

    const paragraphsRes = await this.pg.query(
      `SELECT p.raw_content, p.contextualized_text, d.title as doc_title, d.r2_key, d.r2_url
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       WHERE p.document_id = ANY($1::uuid[])
       ORDER BY p.embedding_high <=> $2::vector LIMIT $3`,
      [candidateIds, JSON.stringify(highQueryVector), topParagraphs]
    );

    const retrievedParagraphs = paragraphsRes.rows;

    // --- CAPA 3: Generación de respuesta con OpenCode API (LLM Free) ---
    const contextText = retrievedParagraphs
      .map((p, i) => `[Fuente ${i + 1} - ${p.doc_title}]:\n${p.raw_content}`)
      .join('\n\n');

    const answer = await this.llm.generateRAGAnswer(userQuery, contextText);

    return {
      answer,
      candidateDocsCount: candidateIds.length,
      sources: retrievedParagraphs,
    };
  }
}
⚡ Instalación Rápida
Bash
npm init -y
npm install @google/genai openai pg @aws-sdk/client-s3 @aws-sdk/s3-request-presigner dotenv
npm install -D typescript @types/node @types/pg tsx