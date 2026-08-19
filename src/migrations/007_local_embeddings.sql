-- 007_local_embeddings.sql: embeddings locales 384d
--
-- Reemplaza los vectores de Gemini (768d documentos / 1536d párrafos) por
-- vectores locales de 384d (transformers.js / ONNX).
--
-- IMPORTANTE: el ALTER ... USING array_fill(0.0) PISA los vectores existentes
-- incluso cuando la columna ya es vector(384) (Postgres re-evalúa el USING en
-- cada ALTER). Por eso se envuelve en un guard: si las columnas YA son
-- vector(384), no se toca nada y los vectores ingestados se conservan.

DO $$
BEGIN
  IF (
    SELECT format_type(a.atttypid, a.atttypmod)
    FROM pg_attribute a
    WHERE a.attrelid = 'public.document_paragraphs'::regclass
      AND a.attname = 'embedding_high'
  ) = 'vector(384)' THEN
    RAISE NOTICE '007 skipped: columns already vector(384), vectors preserved';
    RETURN;
  END IF;

  -- 1. Los índices HNSW dependen de la dimensión del vector: hay que quitarlos
  --    antes de alterar el tipo de columna.
  DROP INDEX IF EXISTS idx_docs_base;
  DROP INDEX IF EXISTS idx_paragraphs_high;

  -- 2. Redimensionar columnas a vector(384), rellenando filas existentes con
  --    vector cero (placeholder hasta la re-ingesta). El vector cero queda
  --    siempre último en búsquedas por coseno (distancia = 1).
  ALTER TABLE documents
    ALTER COLUMN embedding_base TYPE vector(384)
    USING array_fill(0.0, ARRAY[384])::vector(384);

  ALTER TABLE document_paragraphs
    ALTER COLUMN embedding_high TYPE vector(384)
    USING array_fill(0.0, ARRAY[384])::vector(384);

  -- 3. Recrear los índices sobre la nueva dimensión.
  CREATE INDEX IF NOT EXISTS idx_docs_base
    ON documents USING hnsw (embedding_base vector_cosine_ops);

  CREATE INDEX IF NOT EXISTS idx_paragraphs_high
    ON document_paragraphs USING hnsw (embedding_high vector_cosine_ops);
END $$;