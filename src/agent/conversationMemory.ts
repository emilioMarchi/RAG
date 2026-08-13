import { LLMService } from '../services/llmService.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  timestamp: string;
}

export interface SessionData {
  messages: Message[];
  summary?: string;
}

export class ConversationMemory {
  private sessions = new Map<string, SessionData>();
  private maxTurns: number;
  private llmService: LLMService;

  constructor(llmService: LLMService, maxTurns = 10) {
    this.llmService = llmService;
    this.maxTurns = maxTurns;
  }

  /**
   * Obtiene la sesión o la crea si no existe.
   */
  async getOrCreateSession(sessionId: string, systemPrompt?: string): Promise<SessionData> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { messages: [] };
      if (systemPrompt) {
        session.messages.push({
          role: 'system',
          content: systemPrompt,
          timestamp: new Date().toISOString(),
        });
      }
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Agrega un mensaje a la sesión y evalúa si requiere rollover.
   */
  async addMessage(
    sessionId: string,
    role: 'system' | 'user' | 'assistant' | 'function',
    content: string
  ): Promise<void> {
    const session = await this.getOrCreateSession(sessionId);
    session.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });

    await this.maybeSummarize(sessionId);
  }

  /**
   * Obtiene todos los mensajes de una sesión.
   */
  async getMessages(sessionId: string): Promise<Message[]> {
    const session = await this.getOrCreateSession(sessionId);
    return session.messages;
  }

  /**
   * Obtiene los mensajes de la sesión adaptados para el LLM.
   * Si existe un resumen previo, lo inyecta como contexto del sistema al inicio.
   */
  async getHistoryForLLM(sessionId: string): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
    const session = await this.getOrCreateSession(sessionId);
    const result: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    // Si hay un resumen de turnos anteriores, se inyecta como instrucción del sistema al inicio
    if (session.summary) {
      result.push({
        role: 'system',
        content: `[RESUMEN DE TURNOS ANTERIORES]: ${session.summary}`,
      });
    }

    for (const msg of session.messages) {
      // Mapeamos 'function' a 'assistant' para compatibilidad simple con APIs de chat genéricas
      const role = msg.role === 'function' ? 'assistant' : msg.role;
      result.push({
        role,
        content: msg.content,
      });
    }

    return result;
  }

  /**
   * Resetea el historial de la sesión.
   */
  async clearSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /**
   * Rollover: Si los mensajes (excluyendo el prompt del sistema) superan maxTurns,
   * se toman los turnos más antiguos y se resumen agregándolos a session.summary.
   */
  private async maybeSummarize(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Filtramos los mensajes que no sean del sistema para contar los turnos reales
    const systemMessages = session.messages.filter(m => m.role === 'system');
    const interactiveMessages = session.messages.filter(m => m.role !== 'system');

    // Cada turno consta de 2 mensajes (user y assistant) típicamente.
    // Si tenemos más del doble del límite (maxTurns * 2), resumimos la primera mitad de la conversación activa.
    if (interactiveMessages.length > this.maxTurns * 2) {
      const messagesToSummarizeCount = Math.floor(interactiveMessages.length / 2);
      const toSummarize = interactiveMessages.slice(0, messagesToSummarizeCount);
      const toKeep = interactiveMessages.slice(messagesToSummarizeCount);

      const summaryPrompt = `
Eres un asistente que condensa historiales de conversación.
Por favor, resume de forma concisa los siguientes turnos anteriores de chat, manteniendo los detalles clave de lo discutido y cualquier respuesta del sistema.
Este resumen servirá de contexto para los próximos mensajes.

MENSAJES A RESUMIR:
${toSummarize.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}

${session.summary ? `Resumen anterior acumulado:\n${session.summary}\n` : ''}
Genera un resumen unificado y conciso.
`;

      try {
        const response = await this.llmService.complete({
          messages: [{ role: 'user', content: summaryPrompt }],
          temperature: 0.2,
        });

        const newSummary = response.choices[0].message.content?.trim();
        if (newSummary) {
          session.summary = newSummary;
          // Reconstruimos los mensajes de la sesión preservando los del sistema (ej. el System Prompt original) y los mensajes activos a mantener.
          session.messages = [...systemMessages, ...toKeep];
        }
      } catch (error) {
        console.error('[ConversationMemory] Error al resumir historial:', error);
      }
    }
  }
}
