async function listFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const data = await res.json() as { data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }> };
    
    console.log('Modelos gratuitos activos en OpenRouter:');
    const freeModels = data.data.filter(m => m.id.endsWith(':free') || parseFloat(m.pricing.prompt) === 0);
    for (const model of freeModels) {
      console.log(`- ID: ${model.id} (${model.name})`);
    }
  } catch (err) {
    console.error('Error al listar modelos:', err);
  }
}

listFreeModels();
