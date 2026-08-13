import { ConversationMemory } from './conversationMemory.js';
import { AgentLLM } from './agentLLM.js';
import { AgentTools } from './tools.js';
import { AGENT_SYSTEM_PROMPT } from './prompts.js';
import type { RAGSource } from '../services/ragEngine.js';

export interface AgentResponse {
  answer: string;
  intent: 'chat' | 'rag';
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
    // 1. Asegurar inicialización de la sesión con System Prompt
    await this.memory.getOrCreateSession(sessionId, AGENT_SYSTEM_PROMPT);

    // 2. Obtener el historial conversacional formateado para el LLM
    const historyForLLM = await this.memory.getHistoryForLLM(sessionId);
    const historyText = historyForLLM
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    // 3. Decidir ruta (JSON)
    const decision = await this.agentLLM.decideRoute(historyText, query);

    console.log(`[AgentRouter] Decision para sessionId: ${sessionId} -> intent: ${decision.intent}, query refinada: "${decision.query}", motivo: ${decision.reason}`);

    // Agregar el mensaje del usuario a la memoria
    await this.memory.addMessage(sessionId, 'user', query);

    if (decision.intent === 'rag') {
      // 4a. Ejecutar RAG
      const targetQuery = decision.query || query;
      const ragResult = await this.tools.searchDocuments(targetQuery);

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
    } else {
      // 4b. Respuesta de chat directa
      // Volvemos a obtener el historial actualizado con el mensaje del usuario que recién agregamos
      const updatedHistory = await this.memory.getHistoryForLLM(sessionId);
      const answer = await this.agentLLM.generateChatResponse(updatedHistory);

      // Guardar la respuesta del chat directo en la memoria
      await this.memory.addMessage(sessionId, 'assistant', answer);

      return {
        answer,
        intent: 'chat',
      };
    }
  }
}
