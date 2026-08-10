-- 004_graph_rag.sql: Tablas para Graph-RAG (Entidades y Relaciones Semánticas)

CREATE TABLE IF NOT EXISTS document_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  paragraph_id UUID REFERENCES document_paragraphs(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  entity_type VARCHAR(100) NOT NULL, -- ej: Persona, Lugar, Organización, Concepto
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID REFERENCES document_entities(id) ON DELETE CASCADE,
  target_entity_id UUID REFERENCES document_entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL, -- ej: "desarrolla", "pertenece a", "es parte de"
  context_paragraph_id UUID REFERENCES document_paragraphs(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para mejorar velocidad de búsqueda jerárquica y de grafos
CREATE INDEX IF NOT EXISTS idx_entities_document_id ON document_entities (document_id);
CREATE INDEX IF NOT EXISTS idx_entities_paragraph_id ON document_entities (paragraph_id);
CREATE INDEX IF NOT EXISTS idx_entities_name ON document_entities (entity_name);
CREATE INDEX IF NOT EXISTS idx_relations_source ON entity_relations (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON entity_relations (target_entity_id);
