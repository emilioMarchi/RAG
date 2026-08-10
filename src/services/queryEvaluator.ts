import type { LLMService } from './llmService.js';
import { query } from '../config/db.js';

interface EvaluationInput {
  queryText: string;
  answerText: string;
  contextText: string;
  sourcesCount: number;
  cragDecision?: string;
  iterations?: number;
  latencyMs?: number;
}

interface EvalScores {
  faithfulness: number;
  answerRelevance: number;
}

/**
 * QueryEvaluator — Fase 4: Evaluación de calidad post-query.
 *
 * Persiste cada consulta en `query_evaluations` y lanza en background
 * un análisis de fidelidad + relevancia via LLM.
 * El proceso es no bloqueante: la respuesta al usuario no espera la evaluación.
 */
export class QueryEvaluator {
  constructor(private llm: LLMService) {}

  /**
   * Registra la query y lanza la evaluación de métricas en background (fire-and-forget).
   * Retorna el ID del registro creado para trazabilidad.
   */
  async recordAndEvaluate(input: EvaluationInput): Promise<string> {
    // 1. Persistir el registro base (sin scores aún)
    const res = await query<{ id: string }>(
      `INSERT INTO query_evaluations
         (query_text, answer_text, sources_count, crag_decision, iterations, latency_ms, evaluated)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE) RETURNING id`,
      [
        input.queryText,
        input.answerText,
        input.sourcesCount,
        input.cragDecision ?? null,
        input.iterations ?? 1,
        input.latencyMs ?? null,
      ]
    );
    const evalId = res.rows[0].id;

    // 2. Evaluación async en background (no bloqueante)
    this.runEvaluationBackground(evalId, input).catch(err =>
      console.error(`[QueryEvaluator] Background evaluation failed for ${evalId}:`, err)
    );

    return evalId;
  }

  private async runEvaluationBackground(evalId: string, input: EvaluationInput): Promise<void> {
    const scores = await this.scoreWithLLM(input.queryText, input.answerText, input.contextText);

    await query(
      `UPDATE query_evaluations
       SET faithfulness_score = $1,
           answer_relevance_score = $2,
           evaluated = TRUE
       WHERE id = $3`,
      [scores.faithfulness, scores.answerRelevance, evalId]
    );

    console.log(
      `[QueryEvaluator] Evaluated ${evalId}: faithfulness=${scores.faithfulness} relevance=${scores.answerRelevance}`
    );
  }

  private async scoreWithLLM(query: string, answer: string, context: string): Promise<EvalScores> {
    const prompt = `
Eres un evaluador experto de sistemas RAG. Evalúa la respuesta generada en función de dos métricas:

1. **Faithfulness (Fidelidad)**: ¿Está la respuesta completamente respaldada por el contexto provisto, sin añadir información inventada? (0.0 = inventó todo, 1.0 = totalmente fiel al contexto)

2. **Answer Relevance (Relevancia)**: ¿La respuesta responde directamente la pregunta del usuario? (0.0 = no responde, 1.0 = responde perfectamente)

PREGUNTA DEL USUARIO:
"${query}"

CONTEXTO RECUPERADO (fragmento):
${context.substring(0, 1500)}

RESPUESTA GENERADA:
"${answer.substring(0, 800)}"

Responde ESTRICTAMENTE en JSON:
{
  "faithfulness": 0.0-1.0,
  "answer_relevance": 0.0-1.0,
  "notes": "Observación breve (máx 1 oración)"
}
`;

    try {
      const raw = await (this.llm as any).complete({
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.0,
      });

      const content = raw.choices[0].message.content ?? '{}';
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      const parsed = JSON.parse(start !== -1 && end > start ? content.slice(start, end + 1) : content);

      return {
        faithfulness: Math.max(0, Math.min(1, Number(parsed.faithfulness) || 0)),
        answerRelevance: Math.max(0, Math.min(1, Number(parsed.answer_relevance) || 0)),
      };
    } catch {
      return { faithfulness: -1, answerRelevance: -1 }; // -1 = evaluación fallida
    }
  }
}
