-- 006_chunk_locations.sql: Ubicación por chunk en el documento original
-- No cambia columnas; documenta el nuevo shape de `metadata` de document_paragraphs.
--
-- Ahora cada fragmento guarda en metadata.location:
--   { pageNumber?, startChar?, endChar?, startLine?, endLine?, boundingBoxes? }
-- Los documentos ya ingeridos NO tienen `location`: deben re-ingestarse para que
-- el salto del grafo al documento original (DocumentContextViewer) funcione.

-- Reindex rápido (GIN) ya existe (idx_paragraphs_meta); se mantiene.