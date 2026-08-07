import OpenAI from 'openai';
import { env } from '../config/env.js';
import { withRetry } from '../utils/retry.js';

const client = new OpenAI({
  baseURL: env.LLM_API_URL,
  apiKey: env.LLM_API_KEY,
});

export class LLMService {
  private defaultModel: string;

  constructor() {
    this.defaultModel = env.LLM_MODEL;
  }

  async enrichChunk(documentTitle: string, docSummary: string, chunkText: string) {
    return withRetry(
      async () => {
        const prompt = `
Eres un asistente especializado en preparar datos para RAG.
Analiza el siguiente fragmento dentro del contexto del documento general.

DOCUMENTO: "${documentTitle}"
RESUMEN GENERAL: "${docSummary}"
FRAGMENTO: "${chunkText}"

Devuelve ESTRICTAMENTE un JSON con el siguiente formato:
{
  "contextualized_text": "[Antepone un contexto de 1 oracion que ubique al fragmento en el documento] - Fragmento: ${chunkText}",
  "keywords": ["tag1", "tag2"],
  "category": "Nombre de categoría principal"
}
`;

        const response = await client.chat.completions.create({
          model: this.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        if (!content) throw new Error('LLM returned empty response during enrichment');

        return JSON.parse(content) as {
          contextualized_text: string;
          keywords: string[];
          category: string;
        };
      },
      { maxRetries: 3, baseDelay: 2000, label: 'enrich-chunk' }
    );
  }

  async evaluateContext(userQuery: string, contextText: string): Promise<{
    decision: 'answer' | 'expand';
    reason: string;
    expand_requests: Array<{
      docId: string;
      paragraphIndex: number;
      direction: 'before' | 'after';
      count: number;
    }>;
  }> {
    return withRetry(
      async () => {
        const prompt = `
Eres un asistente de RAG que evalúa si el contexto recuperado es suficiente para responder la consulta.

CONSULTA: "${userQuery}"

--- CONTEXTO ACTUAL ---
${contextText}
------------------------

Analiza si el contexto contiene suficiente información para responder.
Si falta información que claramente existe en el documento (porque el contexto actual menciona un tema pero está incompleto), puedes solicitar expandir fuentes específicas.

Responde ESTRICTAMENTE con este JSON:
{
  "decision": "answer" | "expand",
  "reason": "Explica breve por qué decides answer o expand",
  "expand_requests": [
    {
      "docId": "ID del documento (del tag [Fuente N - titulo])",
      "paragraphIndex": NUMERO,
      "direction": "before" | "after",
      "count": 1
    }
  ]
}

REGLAS:
- Si la info está completa o no está en el contexto → decision: "answer"
- Si el contexto menciona un tema pero claramente falta el detalle que sigue → "expand"
- expand_requests SOLO si decision es "expand"
- direction "before" = párrafos anteriores, "after" = siguientes
- count: cuántos párrafos adjuntos pedir (máx 3)
`;

        const response = await client.chat.completions.create({
          model: this.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        console.log(`[EVALUATE DEBUG] LLM raw response: ${content}`);
        if (!content) throw new Error('LLM returned empty response during context evaluation');

        return JSON.parse(content);
      },
      { maxRetries: 2, baseDelay: 2000, label: 'evaluate-context' }
    );
  }

  async generateRAGAnswer(userQuery: string, contextText: string): Promise<string> {
    return withRetry(
      async () => {
        const systemPrompt = `
Eres un asistente preciso y directo. Responde a la pregunta del usuario utilizando EXCLUSIVAMENTE la información provista en el CONTEXTO.
Si la respuesta no está en el contexto, indica amablemente que no dispones de esa información.

--- CONTEXTO RECUPERADO ---
${contextText}
---------------------------
`;

        const response = await client.chat.completions.create({
          model: this.defaultModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userQuery },
          ],
          temperature: 0.2,
        });

        return response.choices[0].message.content || 'Sin respuesta generada.';
      },
      { maxRetries: 3, baseDelay: 2000, label: 'rag-answer' }
    );
  }

  async decomposeQuery(userQuery: string): Promise<string[]> {
    return withRetry(
      async () => {
        const prompt = `
Eres un experto en RAG que descompone consultas complejas del usuario en sub-consultas de búsqueda atómicas e independientes.

EJEMPLO 1:
Consulta: "¿Qué es Cronos y qué cifrado usa en tránsito?"
Salida JSON:
{
  "sub_queries": ["que es Cronos", "cifrado en transito de datos"]
}

EJEMPLO 2:
Consulta: "¿Cuál es el protocolo de comunicaciones internas y qué límite se tolera para la deriva de datos?"
Salida JSON:
{
  "sub_queries": ["protocolo de comunicaciones internas", "limite tolerado para la deriva de datos"]
}

EJEMPLO 3:
Consulta: "¿Qué es RAG?"
Salida JSON:
{
  "sub_queries": ["que es RAG"]
}

Analiza la consulta del usuario y sepárala en sub-consultas si y solo si contiene múltiples intenciones o preguntas unidas por conectores (como 'y', 'además', 'también'). Simplifica los términos para que actúen como mejores búsquedas vectoriales.

Devuelve ESTRICTAMENTE un JSON válido con este formato:
{
  "sub_queries": ["sub_consulta_1", "sub_consulta_2", ...]
}

CONSULTA ORIGINAL: "${userQuery}"
`;

        const response = await client.chat.completions.create({
          model: this.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        console.log(`[DECOMPOSE DEBUG] LLM raw response: ${content}`);
        if (!content) throw new Error('LLM returned empty response during query decomposition');

        const parsed = JSON.parse(content) as { sub_queries: string[] };
        if (!Array.isArray(parsed.sub_queries) || parsed.sub_queries.length === 0) {
          return [userQuery];
        }
        return parsed.sub_queries;
      },
      { maxRetries: 3, baseDelay: 2000, label: 'decompose-query' }
    );
  }
}

