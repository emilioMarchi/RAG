import { LLMService } from '../services/llmService.js';
import { ROUTER_PROMPT } from './prompts.js';

export interface RouteDecision {
  intent: 'chat' | 'rag' | 'list_docs';
  query: string;
  reason: string;
}

export class AgentLLM {
  private llmService: LLMService;

  constructor(llmService: LLMService) {
    this.llmService = llmService;
  }

  /**
   * Decide si la consulta debe enrutarse a RAG o responderse directamente como chat.
   */
  async decideRoute(
    historyText: string,
    userQuery: string
  ): Promise<RouteDecision> {
    const prompt = ROUTER_PROMPT
      .replace('{history}', historyText)
      .replace('{query}', userQuery);

    const response = await this.llmService.complete({
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0].message.content;
    if (!content) {
      console.warn('[AgentLLM] Respuesta vacía en decisión de ruta; se asume rag con la query original.');
      return { intent: 'rag', query: userQuery, reason: 'Respuesta vacía del LLM; fallback a rag.' };
    }

    try {
      const parsed = JSON.parse(content) as RouteDecision;
      if (parsed.intent !== 'chat' && parsed.intent !== 'rag' && parsed.intent !== 'list_docs') {
        throw new Error(`intent inválido: ${parsed.intent}`);
      }
      return parsed;
    } catch {
      // Fallback rudimentario si el JSON.parse directo falla
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start !== -1 && end !== -1 && start < end) {
        try {
          const parsed = JSON.parse(content.slice(start, end + 1)) as RouteDecision;
          if (parsed.intent === 'chat' || parsed.intent === 'rag' || parsed.intent === 'list_docs') return parsed;
        } catch {
          // sigue al fallback final
        }
      }
      console.warn('[AgentLLM] No se pudo parsear la decisión del enrutador; se asume rag con la query original.');
      return { intent: 'rag', query: userQuery, reason: `JSON inválido; fallback a rag. Contenido: ${content}` };
    }
  }

  /**
   * Genera una respuesta honesta cuando el RAG no devolvió información relevante,
   * evitando citar contenido ajeno al tema de la consulta.
   */
  async generateNoResultResponse(
    userQuery: string,
    history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    const hint: { role: 'system'; content: string } = {
      role: 'system',
      content:
        'La búsqueda en la base de conocimiento no devolvió información relevante para la consulta del usuario. ' +
        'Responde con honestidad indicando que no se encontró información sobre el tema en la base de conocimiento, ' +
        'sin inventar datos ni citar documentos. Ofrece ayuda alternativa o pedí más detalles si hace falta.',
    };
    return this.generateChatResponse([hint, ...history]);
  }

  /**
   * Genera una respuesta conversacional directa sin consultar RAG.
   */
  async generateChatResponse(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    try {
      console.log(`[AgentLLM] Enviando ${messages.length} mensajes a generateChatResponse...`);
      const response = await this.llmService.complete({
        messages,
        temperature: 0.7,
      });

      if (!response || !response.choices || response.choices.length === 0) {
        console.error('[AgentLLM] La respuesta del modelo no contiene choices válidos:', JSON.stringify(response));
        return 'Lo siento, no he podido generar una respuesta debido a un error del servicio de lenguaje.';
      }

      return response.choices[0].message.content || 'No pude generar una respuesta.';
    } catch (error) {
      console.error('[AgentLLM] Error en generateChatResponse:', error);
      return 'Lo siento, ocurrió un error al intentar generar la respuesta conversacional.';
    }
  }
}
