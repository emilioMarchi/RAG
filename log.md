El análisis técnico de la arquitectura actual y del plan de integración propuesto demuestra que la base sobre la que trabajas es muy sólida. La arquitectura de dos niveles (Parent-Child) con vectores de distinta dimensión (768d base y 1536d contextualizado), sumada al mapeo preciso de offsets para el visor de documentos y la extracción de grafos, es una estructura de RAG avanzada.A continuación, presento la revisión técnica detallada: lo que está bien pensado, los puntos ciegos o faltantes (especialmente para el nicho legal) y el diseño de integración paso a paso para evolucionar el sistema manteniendo automatización y margen de customización.1. Valoración General del Plan de IntegraciónEl plan de Chunking Estructural (estructura-aware) + Overlap apunta exactamente a resolver el mayor problema del RAG en documentos formales: la fragmentación ciega por número de caracteres. Cortar un artículo o cláusula legal a la mitad destruye el sentido semántico, distorsiona las entidades extraídas para el grafo y genera respuestas incompletas.✅ Aspectos destacados y correctos del plan:Preservación del modelo Parent-Child: Mantener la relación padre (bloque contextual/sección) e hijo (fragmento de búsqueda precisa) es el enfoque correcto para no perder el contexto macro durante la generación del LLM.Independencia del texto original vs. texto preparado: Es excelente que mantengas la llamada a locateOnOriginal(). La técnica del mapa de offsets para la limpieza de palabras cortadas (perso-\nnales → personales) garantiza que el resaltado en el visor no se desalinee aunque el texto procesado por el LLM varíe.Progresión por fases: Dividir en Boundary Detector → Split Estructural → Overlap → Adaptación por Densidad es prudente y minimiza el riesgo de regresiones.2. Puntos Ciegos y Aspectos Faltantes en el PlanPara adaptar el sistema eficientemente al nicho legal y normativo, automatizar la partición por contenido y permitir customización, el plan actual presenta algunos vacíos técnicos que deben resolverse:A. Estructura Jerárquica Normativa vs. "Límites Planos" (Gap Crítico Legal)El plan trata los boundaries (límites) como una lista plana de cortes (Artículo 1, 1), a)). Sin embargo, los documentos legales son árboles jerárquicos estricto-dependientes:$$\text{Título} \rightarrow \text{Capítulo} \rightarrow \text{Sección} \rightarrow \text{Artículo} \rightarrow \text{Inciso / Numeral} \rightarrow \text{Párrafo}$$El problema: Si un hijo corta solo en el Inciso b), el vector embedding del hijo puede perder el dato fundamental de a qué Artículo o Capítulo pertenece si ese contexto no se propaga activamente.Solución necesaria: El detector de fronteras no solo debe encontrar el punto de corte, sino construir un Árbol de Contexto Normativo (AST Normativo corto) para anteceder a cada chunk un header sintético antes de enriquecerlo con Gemini (ej: [Ley 27.541 > Título II > Art. 14 > Inciso b]).B. Manejo de Contaminación por Layout (Cabeceras, Pies de Página y Números de Página)En PDFs normativos, los saltos de página introducen headers/footers intermedios (ej: "Boletín Oficial N° 34.120 - Página 12").Riesgo: Si un Artículo 5 empieza al final de la página 3 y continúa en la página 4, la extracción plana introduce texto espurio en medio del artículo, lo que rompe los regex de fronteras o fragmenta erróneamente el artículo.Solución necesaria: Incluir una fase previa de Sanitización de Layout (Header/Footer Stripping) en extractPDFPages antes del split estructural.C. Mapeo de Ubicación (location) con Overlap en el VisorAl agregar Overlap (solapamiento de caracteres entre hijos contiguos):Riesgo: Los caracteres finales del Child N coincidirán con los iniciales del Child N+1. Si el usuario salta desde una entidad del grafo presente en la zona de overlap, la búsqueda en locateInPages o spansToBoxes del visor podría resaltar ambos chunks o saltar al lugar equivocado.Solución necesaria: La estructura de datos location debe conservar explícitamente el rango útil original sin overlap (coreStartChar, coreEndChar) además del rango ampliado con overlap (extendedStartChar, extendedEndChar).D. Explosión de Entidades Duplicadas en el Grafo RAG por OverlapEl proceso actual ejecuta extractEntitiesAndRelations en cada hijo.Riesgo: Con overlap, las entidades y relaciones ubicadas en la zona solapada se enviarán 2 veces al LLM e insertarán por duplicado en document_entities y entity_relations.Solución necesaria: Implementar deduplicación a nivel de ingestion pipeline mediante claves compuestas (document_id, canonical_entity_name, type) antes del INSERT.E. Cuello de Botella de Rendimiento e IngestaEl pipeline ejecuta en paralelo 5 hijos (mapConcurrent(5)), y cada hijo realiza 2 llamadas pesadas a Gemini (enrichChunk + extractEntitiesAndRelations).Si el split estructural genera más chunks por subdividir incisos legales pequeños, el número de llamadas a la API se disparará, provocando cuellos de botella por Rate Limits (HTTP 429) o fallos de timeout en la transacción SQL.3. Propuesta de Arquitectura e IntegraciónPara integrar estas mejoras de forma limpia sobre Node 22 / TypeScript sin romper el código existente, se propone la siguiente arquitectura modular:                          POST /api/upload
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
         [ PDF / DOCX / TXT ]        [ Metadatos / Presets ]
                    │                         │
                    └────────────┬────────────┘
                                 ▼
                     ChunkingService.extract()
                                 │
                                 ▼
                   ┌──────────────────────────┐
                   │ Layout Sanitizer (PDF)   │ Strip Headers/Footers
                   └─────────────┬────────────┘
                                 ▼
                   ┌──────────────────────────┐
                   │  Boundary & AST Detector │ Construye árbol de estructura
                   └─────────────┬────────────┘ (Capítulo -> Art -> Inciso)
                                 ▼
                   ┌──────────────────────────┐
                   │  Structural ChunkEngine  │ Splits en fronteras reales
                   └─────────────┬────────────┘ con Overlap controlado
                                 ▼
                   ┌──────────────────────────┐
                   │   Ingestion Pipeline     │ Map Concurrent + Deduplicación
                   └──────────────────────────┘ Grafo + DB / pgvector
3.1. Automatización + Customización (Estrategia por Metadatos y Overrides)Para permitir que el sistema funcione automáticamente pero acepte reglas a medida para casos específicos:Auto-Detección (Default):Usa el StrategyDetector existente. Si detecta alta densidad léxica/estructural normativa (score > LEGAL_THRESHOLD), selecciona el motor LegalStructuralStrategy. Si no, GenericStructuralStrategy.Capa de Configuración Custom por Dominio/Nicho (Overrides):Define una interfaz de reglas que permita sobrescribir expresiones regulares sin tocar el código fuente:TypeScript// src/services/chunking/types.ts
export interface StructuralRule {
  name: string;
  pattern: RegExp;
  level: number; // 1: Título/Sección, 2: Artículo, 3: Inciso/Párrafo
  keepContext: boolean; // Si debe incluirse en el header del hijo
}

export interface DomainChunkingProfile {
  domain: string; // 'legal_ar', 'legal_cl', 'contracts', 'generic'
  rules: StructuralRule[];
  parentTargetChars: number;
  childTargetChars: number;
  overlapChars: number;
}
4. Plan de Acción Técnico Modificado (Paso a Paso)Fase 1: Extractor Jerárquico y Sanitizador de LayoutModificar: ChunkingService.extractPDFPagesImplementar: Un filtro que identifique líneas repetitivas al principio/final de las páginas (encabezados/pies de página) y las ignore al construir el fullContentText, manteniendo sus referencias en pages para no romper los bounding boxes.Módulo BoundaryDetector: Retornar no solo un array plano de cortes, sino tokens jerárquicos con su nivel y contexto sintáctico parent:TypeScriptinterface BoundaryMatch {
  offset: number;
  level: number; // 1 = Ley/Capítulo, 2 = Artículo, 3 = Inciso
  title: string; // "ARTÍCULO 15"
  fullHierarchyPath: string; // "TITULO I > CAPITULO II > ARTICULO 15"
}
Fase 2: Splitter Estructural (splitStructural)Ubicación: src/services/chunkingService.tsLógica:Caminar por los límites detectados por la Fase 1.Si un bloque entre dos fronteras de nivel 2 (Artículos) excede childTargetChars, subdividir usando fronteras de nivel 3 (Incisos) o cortes por oración.Si un bloque es menor que el tamaño mínimo, agruparlo con el contiguo sin cruzar fronteras de nivel 1 (Capítulos/Secciones).Fase 3: Overlap con Mapeo de Ubicación DualModificar: splitWithStrategy() en chunkingStrategies.tsAl calcular los cortes del child, guardar en los metadatos del chunk:TypeScriptmetadata: {
  location: {
    pageNumber: 4,
    startChar: 1200,   // Rango con overlap (para vector/LLM)
    endChar: 1800,
    coreStartChar: 1300, // Rango estricto sin overlap (para resaltado en visor)
    coreEndChar: 1800,
    boundingBoxes: [...]
  }
}
Fase 4: Parent-Child Inteligente con Header de ContextoInyectar el fullHierarchyPath generado en la Fase 1 como prefijo del texto del child antes de enviarlo a enrichChunk:Texto enviado a embedding/LLM: [Contexto: Ley 27541 > Art. 12] El incumplimiento de las obligaciones...Texto crudo para el visor (raw_content): El incumplimiento de las obligaciones...Fase 5: Optimización de Ingesta y Deduplicación de GrafoModificar: IngestionPipeline.processAndStoreDocumentAgregar un Set de entidades procesadas a nivel de documento para evitar inserciones duplicadas en document_entities causadas por el overlap:TypeScriptconst entityKey = `${entity.name.toLowerCase()}:${entity.type}`;
if (!seenEntities.has(entityKey)) {
  // Insertar en DB
  seenEntities.add(entityKey);
}
Implementar reintentos exponenciales con catch individual por chunk para llamadas a Gemini, asegurando que si falla un enriquecimiento de un chunk específico no falle toda la transacción del documento.5. Resumen de RecomendacionesAprobar el plan propuesto con las correcciones técnicas señaladas.Priorizar el Header/Footer Stripping y la Jerarquía Normativa (AST) dentro de la Fase 1, ya que el texto legal extraído de PDF suele fallar más por ruido de formato que por falta de expresiones regulares.Asegurar la diferenciación entre rango con overlap y rango core en los metadatos de ubicación para evitar comportamientos erráticos en el visor de contexto.Mantener la arquitectura de perfiles (DomainChunkingProfile) para dar flexibilidad si en el futuro se agregan normativas de otros países o contratos comerciales que usan nomenclaturas distintas (ej: "Cláusula Primera" en lugar de "Artículo 1").