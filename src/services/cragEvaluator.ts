import type { LLMService } from './llmService.js';
import type { RAGSource } from './ragEngine.js';

export type RelevanceDecision = 'RELEVANT' | 'PARTIAL' | 'IRRELEVANT';

export interface CRAGEvaluation {
  decision: RelevanceDecision;
  reason: string;
  reformulated_query?: string; // Query reformulada cuando decision != RELEVANT
}

/**
 * Corrective RAG (CRAG) — Evaluador de relevancia del contexto recuperado.
 *
 * Antes de generar la respuesta final, evalúa si los fragmentos recuperados
 * son suficientes para responder la consulta del usuario.
 * Si la relevancia es PARCIAL o IRRELEVANTE, sugiere una query reformulada
 * para que el engine realice una nueva búsqueda.
 */
export class CRAGEvaluator {
  constructor(private llm: LLMService) {}

  async evaluate(userQuery: string, sources: RAGSource[]): Promise<CRAGEvaluation> {
    if (sources.length === 0) {
      return {
        decision: 'IRRELEVANT',
        reason: 'No se recuperaron fragmentos del retriever.',
        reformulated_query: userQuery,
      };
    }

    const contextSummary = sources
      .map((s, i) => `[${i + 1}] (${s.doc_title}, frag.${s.paragraph_index}):\n${s.raw_content}`)
      .join('\n\n');

    const prompt = `
Eres un evaluador experto en sistemas RAG (Retrieval-Augmented Generation).
Tu tarea es determinar si los fragmentos de contexto recuperados son suficientes para responder la consulta del usuario.

CONSULTA ORIGINAL: "${userQuery}"

FRAGMENTOS RECUPERADOS:
${contextSummary}

Evalúa y responde con EXACTAMENTE uno de estos tres niveles:
- RELEVANT: Los fragmentos contienen la información necesaria para responder completamente la consulta.
- PARTIAL: Los fragmentos contienen información parcialmente relevante pero faltan datos clave.
- IRRELEVANT: Los fragmentos no tienen relación con la consulta o no permiten responderla.

Si el nivel es PARTIAL o IRRELEVANT, proporciona una "reformulated_query" más específica para re-buscar.

Responde ESTRICTAMENTE en JSON:
{
  "decision": "RELEVANT" | "PARTIAL" | "IRRELEVANT",
  "reason": "Explicación breve (máx 2 oraciones)",
  "reformulated_query": "Nueva consulta más específica (solo si decision != RELEVANT)"
}
`;

    try {
      const raw = await (this.llm as any).complete({
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.0,
      });

      const content = raw.choices[0].message.content;
      if (!content) throw new Error('CRAG evaluator: empty LLM response');

      // parseJSON es private en LLMService — usamos JSON.parse directo con limpieza mínima
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      const jsonStr = start !== -1 && end > start ? content.slice(start, end + 1) : content;
      const parsed: CRAGEvaluation = JSON.parse(jsonStr);

      return {
        decision: (['RELEVANT', 'PARTIAL', 'IRRELEVANT'].includes(parsed.decision)
          ? parsed.decision
          : 'RELEVANT') as RelevanceDecision,
        reason: parsed.reason || '',
        reformulated_query: parsed.reformulated_query,
      };
    } catch (err) {
      console.error('[CRAG] Evaluation failed, defaulting to RELEVANT:', err);
      // Ante cualquier falla, dejamos pasar la generación (fail-open)
      return { decision: 'RELEVANT', reason: 'Evaluación fallida; se procede con el contexto disponible.' };
    }
  }
}
