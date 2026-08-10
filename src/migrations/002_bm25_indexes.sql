-- 002_bm25_indexes.sql: Índices GIN + columna tsvector para búsqueda léxica BM25

-- Columna tsvector computada automáticamente sobre raw_content (español + inglés)
ALTER TABLE document_paragraphs
  ADD COLUMN IF NOT EXISTS tsv_content tsvector
    GENERATED ALWAYS AS (
      to_tsvector('spanish', coalesce(raw_content, ''))
    ) STORED;

-- Índice GIN sobre la columna generada (búsqueda full-text eficiente)
CREATE INDEX IF NOT EXISTS idx_paragraphs_tsv
  ON document_paragraphs USING gin (tsv_content);

-- Índice GIN adicional sobre metadata JSONB (ya existe en 001 pero se agrega IF NOT EXISTS para seguridad)
CREATE INDEX IF NOT EXISTS idx_paragraphs_meta_gin
  ON document_paragraphs USING gin (metadata);
