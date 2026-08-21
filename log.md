[RAG] respuesta LLM final: 6334ms
[AgentRouter] RAG completo: 6338ms
[AgentRouter] Ruta rápida sin LLM para sessionId: session_1snfylifzlv_1787092556308 -> rag
[AgentRouter] Decision para sessionId: session_1snfylifzlv_1787092556308 -> intent: rag, query refinada: "articulo 1", motivo: heurística: consulta sobre contenido documental
[DECOMPOSE SKIP] Query simple, sin LLM: "articulo 1"
[RAG] decompose (1 sub-queries): 1ms
[RAG] hybrid search por 1 sub-query(s): 22ms
[RAG] rerank (7 fuentes): 2474ms
[LLM] nvidia/nemotron-3-super-120b-a12b:free stream ok en 6548ms (charsOut=799, label=rag-answer)
[RAG] respuesta LLM final: 9025ms
[AgentRouter] RAG completo: 9029ms
[LLM] nvidia/nemotron-3-super-120b-a12b:free ok en 3115ms (total 3115ms, charsIn=17068, prompt_tokens=4633, completion_tokens=334, label=route)
[AgentRouter] decideRoute (LLM): 3116ms
[AgentRouter] Decision para sessionId: session_1snfylifzlv_1787092556308 -> intent: rag, query refinada: "artículos que hablen sobre sentencias, penas carcelarias o valores monetarios de la Ley 25.326", motivo: El usuario solicita contenido específico sobre sanciones penales y montos, lo que requiere buscar en los documentos.
[LLM] nvidia/nemotron-3-super-120b-a12b:free ok en 33288ms (total 33288ms, charsIn=1091, prompt_tokens=346, completion_tokens=399, label=decompose)
[DECOMPOSE DEBUG] LLM raw response: {
  "sub_queries": ["articulos Ley 25.326 sentencias penas carcelarias valores monetarios"]
}
[RAG] decompose (1 sub-queries): 33291ms
[RAG] hybrid search por 1 sub-query(s): 33339ms
[RAG] rerank (7 fuentes): 35967ms
[LLM] nvidia/nemotron-3-super-120b-a12b:free stream ok en 18525ms (charsOut=4916, label=rag-answer)
[RAG] respuesta LLM final: 54495ms
[AgentRouter] RAG completo: 57615ms

