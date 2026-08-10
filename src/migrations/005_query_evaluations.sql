-- 005_query_evaluations.sql: Tabla de métricas de calidad de respuestas RAG

CREATE TABLE IF NOT EXISTS query_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  sources_count INT NOT NULL DEFAULT 0,
  -- Métricas de calidad (calculadas por el LLM evaluador en background)
  faithfulness_score NUMERIC(4, 3),        -- Fidelidad al contexto (0.000–1.000)
  answer_relevance_score NUMERIC(4, 3),    -- Relevancia de la respuesta (0.000–1.000)
  crag_decision VARCHAR(20),               -- RELEVANT | PARTIAL | IRRELEVANT
  iterations INT NOT NULL DEFAULT 1,       -- Iteraciones del engine iterativo
  latency_ms INT,                          -- Tiempo total de la query en ms
  evaluated BOOLEAN NOT NULL DEFAULT FALSE, -- Si ya fue evaluada en background
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evaluations_created_at ON query_evaluations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluations_evaluated ON query_evaluations (evaluated) WHERE NOT evaluated;
