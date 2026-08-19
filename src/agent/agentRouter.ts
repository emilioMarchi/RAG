import { ConversationMemory } from './conversationMemory.js';
import { AgentLLM, type RouteDecision } from './agentLLM.js';
import { AgentTools } from './tools.js';
import { AGENT_SYSTEM_PROMPT } from './prompts.js';
import { classifyFast } from './queryClassifier.js';
import type { RAGSource } from '../services/ragEngine.js';

export interface AgentResponse {
  answer: string;
  intent: 'chat' | 'rag' | 'list_docs';
  sources?: RAGSource[];
  cragDecision?: string;
  iterations?: number;
}

export class AgentRouter {
  private memory: ConversationMemory;
  private agentLLM: AgentLLM;
  private tools: AgentTools;

  constructor(memory: ConversationMemory, agentLLM: AgentLLM, tools: AgentTools) {
    this.memory = memory;
    this.agentLLM = agentLLM;
    this.tools = tools;
  }

  /**
   * Procesa la entrada del usuario en un turno conversacional.
   */
  async processQuery(sessionId: string, query: string): Promise<AgentResponse> {
    const startedAt = Date.now();
    const mark = (label: string) => {
      console.log(`[AgentRouter] ${label}: ${Date.now() - startedAt}ms`);
    };

    // 1. Asegurar inicialización de la sesión con System Prompt
    await this.memory.getOrCreateSession(sessionId, AGENT_SYSTEM_PROMPT);

    // 2. Obtener el historial conversacional formateado para el LLM
    const historyForLLM = await this.memory.getHistoryForLLM(sessionId);
    const historyText = historyForLLM
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    // Filtro heurístico (sin LLM): salta router y RAG en consultas que no lo necesitan.
    const fast = classifyFast(query);
    if (fast !== 'ask') {
      console.log(`[AgentRouter] Ruta rápida sin LLM para sessionId: ${sessionId} -> ${fast}`);
    }

    if (fast === 'chat') {
      await this.memory.addMessage(sessionId, 'user', query);
      const updatedHistory = await this.memory.getHistoryForLLM(sessionId);
      const answer = await this.agentLLM.generateChatResponse(updatedHistory);
      await this.memory.addMessage(sessionId, 'assistant', answer);
      mark('chat sin RAG (1 llamada LLM)');
      return { answer, intent: 'chat' };
    }

    // 3. Decidir ruta: heurística si es inequívoca, LLM si es ambigua
    let decision: RouteDecision;
    if (fast === 'list_docs') {
      decision = { intent: 'list_docs', query: '', reason: 'heurística: inventario de documentos' };
    } else if (fast === 'rag') {
      decision = { intent: 'rag', query, reason: 'heurística: consulta sobre contenido documental' };
    } else {
      decision = await this.agentLLM.decideRoute(historyText, query);
      mark('decideRoute (LLM)');
    }

    console.log(`[AgentRouter] Decision para sessionId: ${sessionId} -> intent: ${decision.intent}, query refinada: "${decision.query}", motivo: ${decision.reason}`);

    // Agregar el mensaje del usuario a la memoria
    await this.memory.addMessage(sessionId, 'user', query);

    if (decision.intent === 'rag') {
      // 4a. Ejecutar RAG
      const targetQuery = decision.query || query;
      const ragResult = await this.tools.searchDocuments(targetQuery);
      mark('RAG completo');

      // RAG sin resultados relevantes: no citar contenido ajeno; responder honestamente como chat
      const noRelevant =
        ragResult.cragDecision === 'IRRELEVANT' ||
        !ragResult.sources ||
        ragResult.sources.length === 0;

      if (noRelevant) {
        const history = await this.memory.getHistoryForLLM(sessionId);
        const honest = await this.agentLLM.generateNoResultResponse(targetQuery, history);
        await this.memory.addMessage(sessionId, 'assistant', honest);
        return {
          answer: honest,
          intent: 'chat',
        };
      }

      // Guardar la respuesta generada por RAG en la memoria del agente
      await this.memory.addMessage(sessionId, 'assistant', ragResult.content);

      return {
        answer: ragResult.content,
        intent: 'rag',
        sources: ragResult.sources,
        cragDecision: ragResult.cragDecision,
        iterations: ragResult.iterations,
      };
    } else if (decision.intent === 'list_docs') {
      // 4b. Listar documentos disponibles directamente desde la DB
      const docs = await this.tools.listDocuments();
      console.log(`[AgentRouter] list_docs -> ${docs.length} documentos encontrados`);

      let listContext: string;
      if (docs.length === 0) {
        listContext = 'No hay documentos cargados en la base de datos.';
      } else {
        const lines = docs.map((d, i) => {
          const date = new Date(d.created_at).toLocaleDateString('es-AR');
          return `${i + 1}. "${d.title}" (${d.mime_type}) — ${d.paragraph_count} fragmentos — cargado el ${date}`;
        });
        listContext = `Documentos disponibles en la base de datos (${docs.length}):\n${lines.join('\n')}`;
      }

      // Usar el LLM para generar una respuesta natural con ese contexto
      const updatedHistory = await this.memory.getHistoryForLLM(sessionId);
      const hint: { role: 'system'; content: string } = {
        role: 'system',
        content: `El usuario preguntó qué documentos hay disponibles. Aquí está la información exacta de la base de datos:\n${listContext}\nPresenta esta información de forma clara y amigable al usuario.`,
      };
      const answer = await this.agentLLM.generateChatResponse([hint, ...updatedHistory]);
      await this.memory.addMessage(sessionId, 'assistant', answer);
      mark('list_docs completo');

      return {
        answer,
        intent: 'list_docs',
      };
    } else {
      // 4c. Respuesta de chat directa
      // Volvemos a obtener el historial actualizado con el mensaje del usuario que recién agregamos
      const updatedHistory = await this.memory.getHistoryForLLM(sessionId);
      const answer = await this.agentLLM.generateChatResponse(updatedHistory);
      mark('chat directo completo');

      // Guardar la respuesta del chat directo en la memoria
      await this.memory.addMessage(sessionId, 'assistant', answer);

      return {
        answer,
        intent: 'chat',
      };
    }
  }
}
