📄 Especificaciones de Arquitectura de Ingesta Modular (RAG Multipropósito)
Objetivo: Diseñar una estrategia de ingesta y chunking extensible que utilice un procesamiento genérico por defecto, pero permita estrategias especializadas según el tipo/extensión o dominio del documento (comenzando con la estrategia para Normativas/Leyes).

📋 Instrucciones para el Agente de Desarrollo
Instrucción de Inicio:

Revisa la lógica actual de carga e ingesta de documentos. Implementa un patrón de diseño Estrategia (Strategy Pattern) o Pipeline de Procesamiento para separar el Chunking Genérico de las reglas especializadas por tipo de archivo.

1. Arquitectura de Ingesta y Selección de Estrategia
Crea un selector de estrategia de chunking según los metadatos o extensión del archivo al momento de cargarlo:

Python
class ChunkingStrategySelector:
    def get_strategy(self, file_metadata: dict):
        # 1. Si el usuario o el sistema clasifica el documento como normativo/legal
        if file_metadata.get("domain") == "legal" or file_metadata.get("file_type") == "pdf_normativo":
            return LegalNormChunkingStrategy()
        
        # 2. Estrategia para Markdown / Documentación Técnica (Futura extensión)
        elif file_metadata.get("file_extension") == ".md":
            return MarkdownChunkingStrategy()
            
        # 3. Fallback: Estrategia Genérica Multipropósito
        return GenericChunkingStrategy()
2. Estrategia A: GenericChunkingStrategy (Default Multipropósito)
Uso: Para cualquier documento no clasificado o de propósito general (reportes, PDFs estándar, TXT, etc.).

Configuración:

chunk_size: 800 - 1000 caracteres.

chunk_overlap: 150 - 200 caracteres.

separators: ["\n\n", "\n", ". ", " ", ""] (Corta por párrafos, luego oraciones y finalmente palabras).

3. Estrategia B: LegalNormChunkingStrategy (Especializada en Leyes/PDFs)
Uso: Archivos clasificados como normativas, leyes, decretos o regulaciones.

Limpieza Previa (Regex): Reconstruye palabras cortadas por saltos de página o guiones del PDF antes de fragmentar:

Python
import re

def clean_pdf_text(text: str) -> str:
    # Unir palabras cortadas por salto de línea (ej. "perso-\nnales" o "perso\nnales")
    text = re.sub(r'(\w+)-\s*\n\s*(\w+)', r'\1\2', text)
    text = re.sub(r'(?<!\n)\n(?!\n)', ' ', text)
    return text.strip()
Configuración de Fragmentación:

chunk_size: 1200 - 1500 caracteres (Permite capturar definiciones e incisos completos).

chunk_overlap: 250 - 300 caracteres.

separators: Prioriza la estructura legal antes de cortar por párrafo:

Python
separators = [
    "\n\nARTICULO ", 
    "\n\nArt. ", 
    "\n\n— ",       # Guiones/viñetas de definición
    "\n\n", 
    "\n", 
    " "
]
4. Re-ranking y System Prompt (Aplicables a todo el Pipeline)
Independientemente de la estrategia de chunking seleccionada:

Reranking / Cross-Encoder:

Elevar la búsqueda inicial a top_k = 15-20 fragmentos.

Filtrar con Reranker para entregar solo los top 4 a 6 fragmentos con mayor puntuación semántica al LLM, reduciendo el ruido.

System Prompt Ajustado (Generación más explicativa):

Actualizar las instrucciones del sistema para evitar respuestas de una sola oración:

"Eres un asistente experto en análisis de documentación. Responde a la pregunta del usuario de forma clara, directa y estructurada. Desarrolla la respuesta explicando el contexto de la sección/norma donde se encuentra la información. Si la respuesta involucra listas o procedimientos, enumera los elementos completos sin omitir detalles. Cita siempre el documento o sección fuente."

🧪 Criterios de Aceptación para Desarrollo
Modularidad: El código debe permitir procesar un archivo con la lógica genérica sin romper la ingesta, pero poder elegir la lógica de LegalNormChunkingStrategy mediante un parámetro o etiqueta.

Prueba de Ingesta Legal: Al procesar la ley con la estrategia legal, las definiciones largas (ej. Tratamiento de Datos) no deben quedar cortadas en fragmentos pequeños e inconexos.

Calidad de Respuesta: Las respuestas generadas deben ser más ricas en contexto sin importar el tipo de archivo procesado.