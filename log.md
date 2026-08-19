RAG API running on http://localhost:3000
Health: http://localhost:3000/api/health
Embeddings: local (Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384d) | Rerank: local
[LLM] Modelo activo: nvidia/nemotron-3-nano-30b-a3b:free
[LLM] nvidia/nemotron-3-nano-30b-a3b:free ok en 1685ms (total 1685ms, charsIn=2533, prompt_tokens=712, completion_tokens=91, label=route)
[AgentLLM] No se pudo parsear la decisión del enrutador; se asume rag con la query original.
[AgentRouter] decideRoute (LLM): 1688ms
[AgentRouter] Decision para sessionId: session_1snfylifzlv_1787092556308 -> intent: rag, query refinada: "hola", motivo: JSON inválido; fallback a rag. Contenido: {". The user says ": "hola"}
[DECOMPOSE SKIP] Query simple, sin LLM: "hola"
[RAG] decompose (1 sub-queries): 0ms
[RAG] hybrid search por 1 sub-query(s): 226ms
[RAG] rerank (7 fuentes): 1965ms
[LLM] nvidia/nemotron-3-nano-30b-a3b:free ok en 14531ms (total 14531ms, charsIn=14679, prompt_tokens=3755, completion_tokens=401, label=rag-answer)
[RAG] respuesta LLM final: 16504ms
[AgentRouter] RAG completo: 18197ms
