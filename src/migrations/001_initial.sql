-- 001_initial.sql: Schema inicial del módulo RAG jerárquico

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  r2_url TEXT,
  mime_type VARCHAR(100),
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding_base vector(768) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_paragraphs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_index INT NOT NULL,
  raw_content TEXT NOT NULL,
  contextualized_text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  embedding_high vector(1536) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_base
  ON documents USING hnsw (embedding_base vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_paragraphs_high
  ON document_paragraphs USING hnsw (embedding_high vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_paragraphs_meta
  ON document_paragraphs USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_paragraphs_doc_id
  ON document_paragraphs (document_id);
