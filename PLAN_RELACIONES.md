# Planificación: Relaciones Horizontales Ponderadas y Agrupación en el Grafo RAG

Este documento detalla la especificación técnica para implementar relaciones secuenciales y de similitud semántica cruzada con umbralización física en la aplicación **RAG Studio**.

---

## 📐 1. Tipos de Relaciones Propuestas

Actualmente, el grafo se comporta como una estructura en estrella: `Documento (Padre) ─── Fragmentos (Hijos)`. 
Agregaremos dos tipos de relaciones horizontales entre los fragmentos:

```
[ Fragmento A-1 ] ──(Secuencial)──► [ Fragmento A-2 ]
       │
 (Similitud >= 0.78) — Grosor/Atracción según Similitud vector(1536)
       │
[ Fragmento B-4 ] ──(Secuencial)──► [ Fragmento B-5 ]
```

### A. Enlaces Secuenciales (Línea Temporal del Texto)
* **Descripción:** Conecta fragmentos consecutivos ($F_i \rightarrow F_{i+1}$) pertenecientes al mismo documento.
* **Propósito:** Visualizar la estructura y flujo de lectura original de los archivos.
* **Estilo Visual:** Línea continua muy delgada (`width: 0.8`), color gris oscuro atenuado (`#21262d`), con una pequeña flecha indicando la dirección del flujo del texto.

### B. Enlaces Semánticos Cruzados (Clústeres de Conceptos)
* **Descripción:** Conecta fragmentos (sean del mismo documento o de documentos distintos) cuya similitud coseno supere un umbral específico.
* **Propósito:** Mostrar puentes conceptuales y agrupar visualmente la información temáticamente idéntica.
* **Estilo Visual (Ponderado):**
  * **Umbral de Similitud ($T_{sim}$):** $\ge 0.75$ (ajustable por slider en la interfaz).
  * **Peso del Enlace ($W$):** Determina el grosor y el color. 
    * Similitud de $0.75$ a $0.80$: Grosor `1.5px`, color morado translúcido.
    * Similitud de $0.80$ a $0.90$: Grosor `3px`, color morado brillante.
    * Similitud $> 0.90$: Grosor `5px`, color verde/dorado vibrante con efecto de brillo (glow).
  * **Físicas de Vis.js:** Los resortes (springs) entre fragmentos altamente relacionados serán más cortos y fuertes. Esto hará que se atraigan magnéticamente en pantalla formando "nubes temáticas" automáticas.

---

## 🛠️ 2. Arquitectura de Datos y Consultas (pgvector)

Para calcular la similitud semántica de forma eficiente sin saturar la base de datos o el frontend:

### Opción Recomendada: Cálculo en Tiempo Real en Consulta RAG
Cuando el usuario introduce una consulta en el grafo o en el chat:
1. Se recuperan los fragmentos de la base de datos.
2. Se ejecuta una consulta SQL para encontrar relaciones semánticas cruzadas *exclusivamente* entre los fragmentos visibles o cargados en memoria, evitando calcular la matriz de similitud de millones de filas.

```sql
-- Obtener similitud coseno cruzada entre un conjunto de IDs de fragmentos seleccionados
SELECT 
    p1.id as source_id,
    p2.id as target_id,
    (1 - (p1.embedding_high <=> p2.embedding_high)) as similarity
FROM document_paragraphs p1
CROSS JOIN document_paragraphs p2
WHERE p1.id = ANY($1::uuid[]) 
  AND p2.id = ANY($1::uuid[])
  AND p1.id < p2.id -- Evita duplicados (A-B y B-A) y la diagonal autorelacionada (A-A)
  AND (1 - (p1.embedding_high <=> p2.embedding_high)) >= $2; -- Umbral ajustable
```

---

## 🎨 3. Especificación del Frontend (Vis.js Network)

### Configuración del Resorte Dinámico en el Layout
Modificaremos la inicialización de `vis-network` en `app.js` para soportar longitudes de enlaces (longitud de resorte) variables en función del peso semántico:

```javascript
const options = {
  physics: {
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {
      gravitationalConstant: -50,
      centralGravity: 0.015,
      springLength: 100, // Longitud base
      springConstant: 0.08
    }
  },
  edges: {
    smooth: { type: 'continuous' }
  }
};
```

Al renderizar un enlace semántico cruzado:
```javascript
edgesDS.add({
  from: `frag-${source_id}`,
  to: `frag-${target_id}`,
  width: 1 + (similarity * 4), // 1px a 5px
  color: similarity > 0.85 ? '#3fb950' : '#7c3aed',
  length: 120 * (1 - similarity), // A mayor similitud, el resorte es más corto (se juntan más)
  physics: true
});
```

---

## 🚀 4. Plan de Ejecución e Interfaz

1. **Backend:** Crear el endpoint `POST /api/query/relations` para recibir una lista de IDs de fragmentos y un umbral, y devolver la matriz de adyacencia (las conexiones que superan el umbral).
2. **Frontend (Visualización):**
   * Trazar automáticamente las líneas de secuencia al cargar los documentos en el grafo.
   * Renderizar dinámicamente los enlaces conceptuales y aplicar fuerzas al realizar una búsqueda en la barra de consulta del grafo.
   * Agregar un Slider de control en la barra superior del grafo: *"Umbral de Relación Semántica: X%"*.
