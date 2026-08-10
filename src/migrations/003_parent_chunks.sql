-- 003_parent_chunks.sql: Tabla de Parent Chunks para chunking jerárquico

-- Parent chunks: bloques grandes (1200-2000 chars) que contienen el contexto completo
-- Los child chunks (document_paragraphs) apuntan a su parent para recuperar contexto al momento de query
CREATE TABLE IF NOT EXISTS document_parent_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  parent_index INT NOT NULL,          -- índice del bloque grande dentro del documento
  content TEXT NOT NULL,              -- texto completo del bloque (1200-2000 chars)
  start_child_index INT NOT NULL,     -- paragraph_index del primer child que pertenece a este parent
  end_child_index INT NOT NULL,       -- paragraph_index del último child que pertenece a este parent
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- FK en document_paragraphs: cada child apunta a su parent chunk
ALTER TABLE document_paragraphs
  ADD COLUMN IF NOT EXISTS parent_chunk_id UUID REFERENCES document_parent_chunks(id) ON DELETE SET NULL;

-- Índices de acceso
CREATE INDEX IF NOT EXISTS idx_parent_chunks_doc_id
  ON document_parent_chunks (document_id);

CREATE INDEX IF NOT EXISTS idx_paragraphs_parent_id
  ON document_paragraphs (parent_chunk_id);
