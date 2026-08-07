import OpenAI from 'openai';
import { env } from '../src/config/env.js';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: env.LLM_API_KEY,
});

async function testModel(modelName: string) {
  console.log(`\nTesteando modelo: ${modelName}...`);
  try {
    const response = await client.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: 'Responde con un JSON que tenga el campo "status" con valor "ok". Devuelve estrictamente el JSON sin Markdown.' }],
      temperature: 0.1,
    });
    console.log(`Respuesta de ${modelName}:`);
    console.log(response.choices[0].message.content);
  } catch (err) {
    console.error(`Error en ${modelName}:`, err instanceof Error ? err.message : err);
  }
}

async function run() {
  await testModel('google/gemma-4-26b-a4b-it:free');
  await testModel('openrouter/free');
}

run();
