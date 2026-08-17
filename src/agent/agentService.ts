import { LLMService } from '../services/llmService.js';
import { IterativeRAGEngine } from '../services/iterativeRAGEngine.js';
import { ConversationMemory } from './conversationMemory.js';
import { AgentLLM } from './agentLLM.js';
import { AgentTools } from './tools.js';
import { AgentRouter, type AgentResponse } from './agentRouter.js';

export interface AgentConfig {
  maxTurns?: number;
  topDocs?: number;
  topParagraphs?: number;
}

export class AgentService {
  private memory: ConversationMemory;
  private router: AgentRouter;

  constructor(llmService: LLMService, iterativeRag: IterativeRAGEngine, config: AgentConfig = {}) {
    const maxTurns = config.maxTurns ?? 10;
    this.memory = new ConversationMemory(llmService, maxTurns);
    const agentLLM = new AgentLLM(llmService);
    const tools = new AgentTools(iterativeRag, {
      topDocs: config.topDocs,
      topParagraphs: config.topParagraphs,
    });
    this.router = new AgentRouter(this.memory, agentLLM, tools);
  }

  /**
   * Envía un mensaje al agente conversacional.
   */
  async chat(sessionId: string, query: string): Promise<AgentResponse> {
    if (!sessionId) {
      throw new Error('Se requiere un sessionId válido');
    }
    return this.router.processQuery(sessionId, query);
  }

  /**
   * Resetea el historial de la conversación de una sesión.
   */
  async reset(sessionId: string): Promise<void> {
    if (!sessionId) {
      throw new Error('Se requiere un sessionId válido');
    }
    await this.memory.clearSession(sessionId);
  }

  /**
   * Obtiene el historial de mensajes de una sesión.
   */
  async getHistory(sessionId: string) {
    if (!sessionId) {
      throw new Error('Se requiere un sessionId válido');
    }
    return this.memory.getMessages(sessionId);
  }
}
