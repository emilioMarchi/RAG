/**
 * Clasificador heurístico de intención (capa de filtro 0, sin LLM).
 *
 * Corre ANTES del enrutador LLM y del RAG para saltar trabajo caro en
 * consultas que no lo necesitan:
 *  - list_docs → inventario de documentos (respuesta directa desde DB).
 *  - chat      → saludos, agradecimientos, capacidades (no requiere RAG).
 *  - rag       → consultas claramente sobre el CONTENIDO documental
 *                (palabras clave fuertes) → salta el router LLM (-1 llamada).
 *  - ask       → ambiguo: delega en el enrutador LLM como siempre.
 *
 * Este filtro SOLO decide si el RAG (o el router LLM) hace falta: la respuesta
 * final siempre la genera el LLM, nunca hay texto prefabricado.
 */

export type FastIntent = 'chat' | 'list_docs' | 'rag' | 'ask';

const LIST_DOCS_RE =
  /\b(qu[eé] (documentos|archivos|documentaci[oó]n|contenidos|material(es)?) (ten[eé]s|hay|tiene|existen|carg[aá]ron)|qu[eé] (documentos|archivos|contenidos) (est[aá]n|fueron|se (encuentran|subieron)) (cargados?|subidos?|incluidos?)|qu[eé] (ten[eé]s|hay|tiene) (cargado|cargados|disponible|disponibles)|list(a|ame|ar)?(los)? (los |las )?(documentos|archivos)|mostr[aá](me)? (los )?(documentos|archivos)|inventario|cu[aá]les (son|hay) (los|las)? ?(documentos|archivos)|qu[eé] tengo cargado|qu[eé] tienen cargado|c[oó]mo se llama(n)? (los|las) (documentos|archivos))\b/i;

const RAG_RE =
  /\b(art[ií]culo|art\.?\s*\d|ley\s*\d|decreto|resoluci[oó]n|reglament|secci[oó]n|cap[ií]tulo|inciso|cl[aá]usula|anexo|ap[eé]ndice|definici[oó]n|t[eé]rmino|qu[eé] dice|qu[eé] establece|qu[eé] indica|qu[eé] dispone|texto de(l| la)?|contenido del?|procedimiento|protocolo|cifrado|en tr[aá]nsito|requisito|obligaci[oó]n|multa|sanci[oó]n|de qu[eé] trata|res[uú]m[ií](me|mi|r|a|an|e)?|resume|cu[aá]les son los temas|conceptos|norma)\b/i;

const CHAT_RE =
  /\b(hola|holi|buenas|buen(a|os) d[ií]as|buenas tardes|buenas noches|chau|adi[oó]s|hasta luego|nos vemos|gracias|muchas gracias|te (agradezco|agradecer[ií]a)|c[oó]mo est[aá]s|qu[eé] tal)\b|\b(qu[eé] (pod[eé]s|sab[eé]s|hac[eé]s|puedes) (hacer|decir|contar)?|qu[eé] eres|qui[eé]n sos|qu[eé] sos|c[oó]mo funcion[aá]s|sos un (bot|robot|ia|asistente|programa)|qu[eé] es rag|ay[uú]dame|ayuda|sos una (ia|inteligencia artificial))\b/i;

export function classifyFast(query: string): FastIntent {
  const q = (query || '').trim();
  if (!q) return 'ask';
  if (LIST_DOCS_RE.test(q)) return 'list_docs';
  if (RAG_RE.test(q)) return 'rag';
  if (CHAT_RE.test(q)) return 'chat';
  return 'ask';
}