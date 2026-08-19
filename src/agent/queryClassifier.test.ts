import { describe, it, expect } from 'vitest';
import { classifyFast } from './queryClassifier.js';

describe('classifyFast', () => {
  it.each([
    ['¿Qué documentos tenés?', 'list_docs'],
    ['¿Qué archivos están cargados?', 'list_docs'],
    ['¿Qué documentación hay disponible?', 'list_docs'],
    ['Listame los documentos', 'list_docs'],
    ['Mostrame los archivos', 'list_docs'],
    ['¿Cuáles son los documentos cargados?', 'list_docs'],
    ['¿Qué tengo cargado?', 'list_docs'],
    ['¿Cómo se llaman los documentos?', 'list_docs'],
  ])('detecta inventario: "%s" -> %s', (q, expected) => {
    expect(classifyFast(q)).toBe(expected);
  });

  it.each([
    ['¿Qué dice el artículo 3?', 'rag'],
    ['Pasame el texto del artículo 4', 'rag'],
    ['¿Qué establece la ley 25.326?', 'rag'],
    ['Contenido del artículo 1', 'rag'],
    ['¿Qué dice el capítulo 5?', 'rag'],
    ['¿Cuáles son los requisitos de la norma?', 'rag'],
    ['Resumime los temas principales', 'rag'],
    ['Explicame el procedimiento de la sección 2', 'rag'],
    ['¿Qué cifrado usa en tránsito?', 'rag'],
  ])('detecta contenido documental: "%s" -> %s', (q, expected) => {
    expect(classifyFast(q)).toBe(expected);
  });

  it.each([
    ['hola', 'chat'],
    ['Hola, ¿qué podés hacer?', 'chat'],
    ['buenas tardes', 'chat'],
    ['gracias', 'chat'],
    ['muchas gracias por tu ayuda', 'chat'],
    ['chau', 'chat'],
    ['¿quién sos?', 'chat'],
    ['¿cómo funcionás?', 'chat'],
    ['¿qué es rag?', 'chat'],
    ['¿sos un bot?', 'chat'],
    ['ayudame', 'chat'],
  ])('detecta conversación social: "%s" -> %s', (q, expected) => {
    expect(classifyFast(q)).toBe(expected);
  });

  it('delega en el LLM lo ambiguo', () => {
    expect(classifyFast('¿podés contarme más?')).toBe('ask');
    expect(classifyFast('me interesa el tema de las sanciones')).toBe('ask');
  });
});