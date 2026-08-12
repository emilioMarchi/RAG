import OpenAI from 'openai';
import type { ScoredChunk } from './hybridSearchService.js';
import { env } from '../config/env.js';
import { withRetry } from '../utils/retry.js';

const client = new OpenAI({
  baseURL: env.LLM_API_URL,
  apiKey: env.LLM_API_KEY,
});

export class LLMService {
  private models: string[];

  constructor() {
    this.models = [env.LLM_MODEL, ...(env.LLM_BACKUP_MODEL ? [env.LLM_BACKUP_MODEL] : [])];
  }

  private isRateLimit(error: unknown): boolean {
    const e = error as { status?: number; message?: string };
    return (
      e?.status === 429 ||
      /429|rate limit|Too Many Requests|RateLimited/i.test(String(e?.message ?? error))
    );
  }

  private async complete(
    params: Omit<OpenAI.Chat.ChatCompletionCreateParams, 'model'>
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    let lastError: unknown;
    let sawRateLimit = false;
    for (const candidate of this.models) {
      try {
        const result = await client.chat.completions.create({ ...params, model: candidate });
        return result as OpenAI.Chat.Completions.ChatCompletion;
      } catch (error) {
        if (!this.isRateLimit(error)) throw error;
        lastError = error;
        sawRateLimit = true;
      }
    }
    if (sawRateLimit) {
      console.warn(
        `[LLM] todos los modelos rate-limited (429). Modelos: ${this.models.join(', ')}`
      );
    }
    throw lastError;
  }

  private parseJSON<T>(content: string): T {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    const candidate = start !== -1 && end !== -1 && end > start
      ? content.slice(start, end + 1)
      : content;

    let raw = candidate;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // El LLM a veces inserta caracteres de control crudos (saltos de línea,
      // tabs) *dentro* de los literales de string sin escaparlos. Los whitespace
      // entre tokens JSON sí son válidos y no deben tocarse, así que escapamos
      // solo el interior de las cadenas (con un escáner que respeta comillas).
      raw = this.escapeControlCharsInsideStrings(raw);
      return JSON.parse(raw) as T;
    }
  }

  private escapeControlCharsInsideStrings(input: string): string {
    const chars = [...input];
    let out = '';
    let inString = false;
    let prevSlash = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (inString) {
        if (ch === '"' && prevSlash % 2 === 0) {
          inString = false;
          out += ch;
        } else if (ch === '\t') {
          out += '\\t';
        } else if (ch === '\r') {
          out += '\\r';
        } else if (ch === '\n') {
          out += '\\n';
        } else if (ch.charCodeAt(0) < 0x20 && ch !== '\\') {
          // otros controles crudos dentro del string
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
      } else {
        if (ch === '"') {
          inString = true;
        }
        out += ch;
      }
      prevSlash = ch === '\\' ? prevSlash + 1 : 0;
    }
    return out;
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

Devuelve ESTRICTAMENTE un JSON con el siguiente formato (NO copies el fragmento en la respuesta):
{
  "context_prefix": "[Antepone un contexto de 1 oracion que ubique al fragmento en el documento, sin repetir el texto del fragmento]",
  "keywords": ["tag1", "tag2"],
  "category": "Nombre de categoría principal"
}
`;

        const response = await this.complete({
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        if (!content) throw new Error('LLM returned empty response during enrichment');

        const parsed = this.parseJSON<{
          context_prefix: string;
          keywords: string[];
          category: string;
        }>(content);

        return {
          contextualized_text: this.assembleContextualized(parsed.context_prefix, chunkText),
          keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
          category: parsed.category || 'general',
        };
      },
      { maxRetries: 3, baseDelay: 2000, label: 'enrich-chunk' }
    );
  }

  private assembleContextualized(prefix: string, chunkText: string): string {
    const cleanPrefix = (prefix || '').replace(/\s+/g, ' ').trim();
    if (!cleanPrefix) return chunkText;
    return `${cleanPrefix} - Fragmento: ${chunkText}`;
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
- Si la info está completa O si responder con el contexto actual es lo mejor que se puede → decision: "answer"
- Si el contexto menciona un tema pero claramente falta el detalle que sigue y ese detalle puede estar en párrafos ADYACENTES del mismo documento → "expand"
- Si el dato que falta no parece estar en los párrafos cercanos (el fragmento ya cubre el tema, o es un dato de otro documento no recuperado), NO pidas expandir: responde "answer" y continúa con lo que haya. Evita pedir más contexto repetidas veces sin progreso.
- expand_requests SOLO si decision es "expand"
- direction "before" = párrafos anteriores, "after" = siguientes
- count: cuántos párrafos adjuntos pedir (máx 3)
- En "reason" indica el fragmento del contexto que apoyó tu decisión
`;

        const response = await this.complete({
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        console.log(`[EVALUATE DEBUG] LLM raw response: ${content}`);
        if (!content) throw new Error('LLM returned empty response during context evaluation');

        return this.parseJSON(content);
      },
      { maxRetries: 2, baseDelay: 2000, label: 'evaluate-context' }
    );
  }

  async generateRAGAnswer(userQuery: string, contextText: string): Promise<string> {
    return withRetry(
      async () => {
        const systemPrompt = `
Eres un asistente experto en análisis de documentación. Responde a la pregunta del usuario de forma clara, directa y estructurada. Desarrolla la respuesta explicando el contexto de la sección/norma donde se encuentra la información. Si la respuesta involucra listas o procedimientos, enumera los elementos completos sin omitir detalles. Cita siempre el documento o sección fuente.

IMPORTANTE: Responde utilizando EXCLUSIVAMENTE la información provista en el CONTEXTO.
Si la respuesta no está en el contexto, indica amablemente que no dispones de esa información.
Evita respuestas de una sola oración: desarrolla el contexto suficiente para que la respuesta sea entendible por sí sola.

Los fragmentos recuperados suelen contener SOLO parte de lo preguntado. No respondas "No dispongo de esa información" de forma genérica: responde con todo lo que SÍ aparece en el contexto y, si faltan datos, indícalo de forma específica.

CITAS OBLIGATORIAS: Cada vez que uses información de un fragmento, debes citarlo INMEDIATAMENTE usando el siguiente formato de markdown (sin espacios):
[[N]](frag-{id})
Donde N es el número de la fuente (ej: 1, 2...) e {id} es el UUID que aparece después de "| id:" en el encabezado de la fuente correspondiente.
Ejemplo: si el encabezado dice "[Fuente 2 - MiDoc (fragmento 3) | id:abc-123]", la cita es [[2]](frag-abc-123)
NO omitas las citas. Si la información proviene de múltiples fuentes, cita todas las relevantes.

--- CONTEXTO RECUPERADO ---
${contextText}
---------------------------
`;

        const response = await this.complete({
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

        const response = await this.complete({
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        console.log(`[DECOMPOSE DEBUG] LLM raw response: ${content}`);
        if (!content) throw new Error('LLM returned empty response during query decomposition');

        const parsed = this.parseJSON<{ sub_queries: string[] }>(content);
        if (!Array.isArray(parsed.sub_queries) || parsed.sub_queries.length === 0) {
          return [userQuery];
        }
        return parsed.sub_queries;
      },
      { maxRetries: 3, baseDelay: 2000, label: 'decompose-query' }
    );
  }

  /**
   * Cross-encoder scoring: puntúa en un único batch la relevancia de cada fragmento.
   * Devuelve un array de scores [0-1] en el mismo orden que `chunks`.
   */
  async rerankChunks(userQuery: string, chunks: ScoredChunk[]): Promise<number[]> {
    return withRetry(
      async () => {
        const snippets = chunks
          .map(
            (c, i) =>
              `[${i}] (Documento: ${c.doc_title})\n${c.raw_content.substring(0, 400)}`
          )
          .join('\n\n');

        const prompt = `
Eres un evaluador de relevancia para un sistema RAG.
Dada una consulta del usuario y una lista de fragmentos de texto numerados, asigna a cada fragmento un puntaje de relevancia entre 0.0 y 1.0.

CRITERIOS:
- 1.0 = El fragmento responde DIRECTAMENTE la consulta
- 0.7-0.9 = El fragmento contiene información muy relevante
- 0.4-0.6 = El fragmento es parcialmente relevante
- 0.1-0.3 = El fragmento tiene muy poca relación
- 0.0 = El fragmento no tiene ninguna relación

CONSULTA: "${userQuery}"

FRAGMENTOS:
${snippets}

Devuelve ESTRICTAMENTE un JSON con este formato (un score por fragmento, en orden):
{
  "scores": [0.0, 0.8, ...]
}
`;

        const response = await this.complete({
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.0,
        });

        const content = response.choices[0].message.content;
        if (!content) throw new Error('LLM returned empty response during reranking');

        const parsed = this.parseJSON<{ scores: number[] }>(content);
        const scores = Array.isArray(parsed.scores) ? parsed.scores : [];

        // Asegurar que haya un score por cada chunk (rellenar con 0 si falta)
        return chunks.map((_, i) => {
          const s = scores[i];
          return typeof s === 'number' && isFinite(s) ? Math.max(0, Math.min(1, s)) : 0;
        });
      },
      { maxRetries: 2, baseDelay: 2000, label: 'rerank-chunks' }
    );
  }
  async extractEntitiesAndRelations(documentTitle: string, chunkText: string): Promise<{
    entities: Array<{ name: string; type: string }>;
    relations: Array<{ source_entity: string; target_entity: string; relation_type: string }>;
  }> {
    return withRetry(
      async () => {
        const prompt = `
Eres un asistente experto en procesamiento de lenguaje natural y modelado de grafos de conocimiento.
Analiza el siguiente fragmento de texto perteneciente al documento "${documentTitle}" y extrae:
1. **Entidades**: Conceptos clave, tecnologías, sistemas, personas, organizaciones o lugares.
2. **Relaciones**: Conexiones semánticas directas entre las entidades extraídas dentro de este fragmento.

FRAGMENTO:
"${chunkText}"

Devuelve ESTRICTAMENTE un JSON con el siguiente formato:
{
  "entities": [
    { "name": "Nombre exacto de la entidad", "type": "Persona" | "Organización" | "Tecnología" | "Sistema" | "Concepto" | "Lugar" }
  ],
  "relations": [
    { "source_entity": "Nombre exacto de la entidad origen", "target_entity": "Nombre exacto de la entidad destino", "relation_type": "verbo o relacion corta en minúscula (ej: desarrolla, implementa, es parte de, cifra)" }
  ]
}

Reglas:
- Sé preciso. Extrae únicamente entidades y relaciones explícitas en el texto.
- Asegúrate de que los nombres de las entidades en "relations" coincidan exactamente con los nombres listados en "entities".
- Si no hay entidades o relaciones claras, devuelve arrays vacíos.
`;

        const response = await this.complete({
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const content = response.choices[0].message.content;
        if (!content) throw new Error('LLM returned empty response during entity extraction');

        const parsed = this.parseJSON<{
          entities: Array<{ name: string; type: string }>;
          relations: Array<{ source_entity: string; target_entity: string; relation_type: string }>;
        }>(content);

        return {
          entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          relations: Array.isArray(parsed.relations) ? parsed.relations : [],
        };
      },
      { maxRetries: 2, baseDelay: 2000, label: 'extract-entities' }
    );
  }
}


