# Guía de uso - Hierarchical Contextual RAG Module

## Requisitos previos
- PostgreSQL 16+ con extensión `pgvector`
- Node.js 20+
- Credenciales configuradas en `.env`

## Configuración inicial

### 1. Base de datos (Docker)
```bash
docker run -d \
  --name rag-postgres \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=rag_db \
  pgvector/pgvector:pg16
```

### 2. Variables de entorno (`.env`)
```env
# Gemini (solo embeddings)
GEMINI_API_KEY=tu_clave_gemini

# LLM API (OpenAI-compatible, ej: OpenRouter)
LLM_API_URL=https://openrouter.ai/api/v1
LLM_API_KEY=tu_clave_openrouter
LLM_MODEL=nvidia/nemotron-3-nano-30b-a3b:free

# PostgreSQL + pgvector
DATABASE_URL=postgres://postgres:postgres@localhost:5432/rag_db

# Cloudflare R2 Storage
CLOUDFLARE_ACCOUNT_ID=tu_account_id
R2_ACCESS_KEY_ID=tu_access_key
R2_SECRET_ACCESS_KEY=tu_secret_key
R2_BUCKET_NAME=rag-app
R2_PUBLIC_DOMAIN=https://pub-xxx.r2.dev

# Server
PORT=3000
```

### 3. Inicializar proyecto
```bash
npm install
npm run build      # Compila TypeScript a dist/
npm run migrate    # Crea esquema DB (tablas + índices HNSW)
npm run dev        # Desarrollo con hot-reload
# O en producción:
node dist/index.js
```

---

## Flujo de uso

### A. Subir documentos
```bash
# Soporta: .txt, .md, .pdf, .docx
curl -X POST -F "file=@documento.pdf" http://localhost:3000/api/upload
```

**Respuesta exitosa:**
```json
{
  "message": "Documento procesado exitosamente",
  "docId": "uuid",
  "r2Key": "documents/timestamp-filename.pdf",
  "paragraphsProcessed": 12
}
```

**Proceso interno:**
1. Archivo → temporal en disco
2. Extracción de texto según MIME type
3. División en párrafos (mín 20 chars)
4. **Transacción atómica en PostgreSQL:**
   - Sube archivo original a **R2** (persistente)
   - Embedding 768d del documento completo → `documents.embedding_base`
   - Por cada párrafo:
     - LLM enriquece: contexto + keywords + categoría
     - Embedding 1536d del texto enriquecido → `document_paragraphs.embedding_high`
     - Guarda: raw_content, contextualized_text, metadata, embedding_high

### B. Consultar (RAG)
```bash
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "¿Qué es RAG?", "topDocs": 5, "topParagraphs": 3}'
```

**Respuesta:**
```json
{
  "answer": "RAG combina recuperación y generación...",
  "sources": [
    {
      "doc_title": "documento.pdf",
      "raw_content": "Texto original del párrafo...",
      "contextualized_text": "Este documento explica RAG. - Fragmento: ...",
      "r2_key": "documents/...",
      "r2_url": "https://pub-xxx.r2.dev/documents/..."
    }
  ]
}
```

**Proceso interno (búsqueda jerárquica):**
1. Embedding query 768d → top-N documentos por `embedding_base` (HNSW cosine)
2. Embedding query 1536d → top-M párrafos de esos docs por `embedding_high`
3. Construye contexto con `contextualized_text` de párrafos
4. LLM genera respuesta usando **SOLO** el contexto proporcionado
5. Devuelve respuesta + fuentes con URLs firmadas a R2

### C. Gestión de documentos
```bash
# Listar
curl http://localhost:3000/api/documents

# Eliminar (borra de PG + R2)
curl -X DELETE http://localhost:3000/api/documents/<docId>
```

---

## Respuesta a tu pregunta: ¿Los archivos son temporales?

**NO.** El archivo original se sube a **Cloudflare R2** (almacenamiento de objetos persistente tipo S3) durante la ingesta y **permanece ahí permanentemente**.

- **Temporal**: Solo el archivo en disco del servidor durante el procesamiento (se borra tras extraer texto)
- **Persistente en R2**: El archivo original completo, accesible via `r2_url` firmada
- **Persistente en PostgreSQL**: Texto extraído, embeddings, metadatos enriquecidos

Al eliminar un documento (`DELETE /api/documents/:id`):
1. Borra de `documents` y `document_paragraphs` (CASCADE)
2. Borra el objeto de R2 via `r2_key`

---

## Arquitectura de datos

```
documents
├── id (UUID, PK)
├── title, content (texto completo)
├── r2_key, r2_url (referencia a archivo en R2)
├── mime_type
├── embedding_base (vector(768)) — búsqueda doc-level
└── created_at

document_paragraphs
├── id (UUID, PK)
├── document_id (FK → documents, CASCADE)
├── paragraph_index
├── raw_content (texto original)
├── contextualized_text (enriquecido por LLM)
├── metadata (keywords[], category)
├── embedding_high (vector(1536)) — búsqueda chunk-level
└── created_at

Índices HNSW:
- idx_docs_base ON documents(embedding_base vector_cosine_ops)
- idx_paragraphs_high ON document_paragraphs(embedding_high vector_cosine_ops)
- idx_paragraphs_meta GIN(metadata)
- idx_paragraphs_doc_id ON document_paragraphs(document_id)
```

---

## Tests
```bash
npm test           # 23 tests unitarios (vitest)
npm run test:watch # Modo watch
```

---

## Producción
```bash
npm run build
npm run migrate
NODE_ENV=production node dist/index.js
```

El servidor expone:
- `GET  /api/health`
- `POST /api/upload` (multipart/form-data, field: `file`)
- `GET  /api/documents`
- `DELETE /api/documents/:id`
- `POST /api/query` (JSON: `{query, topDocs?, topParagraphs?}`)