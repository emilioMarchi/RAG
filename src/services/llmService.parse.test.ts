import { describe, it, expect } from 'vitest';
import { LLMService } from '../services/llmService.js';

// @ts-expect-error - parseJSON es privado; lo accedemos para testear
const svc = new LLMService();
const parseJSON = svc.parseJSON.bind(svc);

describe('LLMService.parseJSON', () => {
  it('parsea JSON limpio', () => {
    const r = parseJSON('{"a":1,"b":"x"}');
    expect(r).toEqual({ a: 1, b: 'x' });
  });

  it('extrae JSON rodeado de texto/markdown', () => {
    const r = parseJSON('```json\n{"a":1}\n```');
    expect(r).toEqual({ a: 1 });
  });

  it('escapa control crudo (newline) dentro de string pero no el whitespace entre tokens', () => {
    // pretty JSON: newline entre tokens es valido; dentro de contextualized hay raw newline
    const content = '{\n  "contextualized_text": "linea1\nlinea2\tcon tab",\n  "keywords": ["a"]\n}';
    const r = parseJSON(content);
    expect(r.contextualized_text).toBe('linea1\nlinea2\tcon tab');
  });
});
