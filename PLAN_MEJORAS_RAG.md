¿Cómo adaptar PDF.js a tu RAG para ubicar y subrayar texto?
Aunque el video solo muestra el uso básico del visor, PDF.js es justamente la librería clave para lograr interactividad en web. Para lograr ubicar fragmentos o palabras clave provenientes de tu RAG y subrayarlos en tiempo real, existen dos enfoques principales:

1. Usar las capas nativas de PDF.js (TextLayer y AnnotationLayer)
PDF.js renderiza los documentos dibujando los elementos visuales en un <canvas> y superponiendo una capa de texto transparente (TextLayer) para permitir la selección y búsqueda.

Uso del PDFFindController: PDF.js cuenta con un controlador interno de búsqueda. Puedes enviarle los fragmentos o palabras clave retornados por tu RAG para que ubique las Coincidencias en el documento automáticamente.

Coordenadas de Bounding Boxes: Si tu backend RAG (o la herramienta de extracción del PDF) te retorna las coordenadas exactas de las palabras o fragmentos (x, y, ancho, alto y número de página), puedes dibujar directamente rectángulos semitransparentes sobre la capa de anotaciones o el lienzo canvas para simular el subrayado marcador.

2. Librerías complementarias construidas sobre PDF.js
Integrar el visor de PDF.js crudo e implementar la manipulación del DOM manualmente puede ser complejo. Por ello, en el ecosistema RAG se suelen integrar wrappers o bibliotecas que extienden PDF.js:

react-pdf-highlighter (o similar si usas React): Permite pasar coordenadas/rangos de texto y renderizar resúmenes o subrayados interactivos (highlights) sobre las páginas del PDF automáticamente.

PDF.js Express / PSPDFKit: Alternativas comerciales (con capas gratuitas) construidas sobre la base de PDF.js que simplifican la API para agregar/eliminar anotaciones, marcas de texto y resaltados programáticamente.

Mapeo típico entre RAG y el Visor de PDF
Ingesta y Parsing (Backend): Cuando procesas el PDF para tu base de vectores, guarda no solo el texto del chunk, sino también los metadatos de ubicación: número de página (page_number) y, de ser posible, los bounding boxes o índice de caracteres.

Consulta RAG: El usuario consulta y el RAG devuelve la respuesta junto con las citas o chunks relevantes y sus metadatos de posición.

Renderizado en el Frontend:

Cargas el PDF usando PDF.js.

Navegas automáticamente a la página especificada en el chunk (pdfViewer.currentPageNumber = page).

Ejecutas la búsqueda con el texto del fragmento o aplicas una capa de resaltado CSS/Canvas en las coordenadas indicadas.


Estrategia Recomendada: Renderizado Integrado en el Frontend

Para mantener el control total que buscas en tus módulos RAG sin reinventar el renderizado completo de PDFs, la combinación ideal es usar PDF.js en el frontend conectado con los metadatos de ubicación que extraiga tu backend.

### Opción 1: Desarrollo propio ligero con PDF.js (Control Total)
Si quieres controlar el 100% de la interfaz sin frameworks pesados de terceros:
* **Backend (Python / Node):** Al segmentar el PDF para las incrustaciones (embeddings), utiliza librerías como PyMuPDF (fitz) o pdfplumber. Estas no solo extraen el texto del chunk, sino también las coordenadas ($x, y, w, h$) y el número de página.
* **Metadata del Chunk:** Almacena en la base de vectores la estructura del resultado:
```json
{
  "text": "fragmento recuperado...",
  "page": 3,
  "bbox": [x0, y0, x1, y1]
}
```
* **Frontend:** Implementa PDF.js y utiliza su TextLayer. Cuando el usuario haga clic en una cita o fuente de la respuesta del RAG:
  1. Haces salto de página con `pdfViewer.currentPageNumber = metadata.page`.
  2. Dibujas un div de resalte con CSS sobre la capa de texto usando las coordenadas bbox convertidas a la escala actual de la página.

### Opción 2: Usar Wrappers Abiertos (Desarrollo Rápido)
Si usas React o Vue en tu panel de consulta, existen componentes listos basados en PDF.js diseñados específicamente para casos de uso estilo RAG:
* **react-pdf-highlighter:** Biblioteca open-source pensada para resaltar pasajes de texto a partir de rangos de coordenadas o búsquedas exactas. Soporta marcas persistentes y eventos de clic sobre los fragmentos resaltados.
* **pdfjs-dist + mark.js:** Si prefieres Javascript nativo o no tienes coordenadas exactas (solo el texto del fragmento), puedes usar mark.js directamente sobre el DOM renderizado por la TextLayer de PDF.js para subrayar las coincidencias del texto de forma dinámica.

### Opción 3: Lectores interactivos listos (Plug & Play)
Si buscas una solución con interfaz preconstruida para integrar vía iframe o componente web:
* **PDF.js Express (Free Tier):** Incluye APIs nativas para añadir marcas de texto (Annotations) mediante código con una línea de comandos tipo `annotManager.addAnnotation(...)`.

---

## Plan de Implementación de Mejoras en Interfaz Web

Para optimizar el visor de documentos actual ([viewer.js](file:///D:/Emi/apps/RAG/public/viewer.js)), se estructuran las mejoras en tres fases de implementación consecutivas:

### Fase 1: Renderizado Perezoso (Lazy Loading) de Páginas PDF
**Objetivo:** Evitar renderizar decenas de páginas concurrentemente en canvas, mejorando el rendimiento y uso de memoria en documentos grandes.
1. **Creación del esqueleto virtual:** Modificar el bucle de renderizado en `renderPDF` para crear los contenedores `.pdf-page` con su tamaño correcto (usando el viewport de la página sin renderizar el canvas inmediatamente).
2. **Uso de IntersectionObserver:** Configurar un observador de intersección que detecte cuándo un contenedor `.pdf-page` entra o está cerca de entrar en el área visible.
3. **Renderizado bajo demanda:** Al activarse el observador para una página, ejecutar el renderizado del canvas (`page.render(...)`) y la construcción de la `textLayer` e inyección de resaltados (`pdf-hl`).

### Fase 2: Búsqueda Semántica desde Selección de Texto en PDF
**Objetivo:** Permitir que los usuarios seleccionen cualquier texto dentro del PDF y puedan ejecutar búsquedas semánticas directas.
1. **Delegación de eventos mouseup:** Escuchar el evento `mouseup` en el contenedor principal `#viewer-pdf`.
2. **Detección de selección:** Usar `window.getSelection()` para obtener el texto seleccionado de la `textLayer` del PDF.
3. **Menú contextual flotante:** Mostrar el menú `#viewer-menu` en la posición del cursor de la misma forma que se hace en la vista de texto normal.

### Fase 3: Buscador Interno de Texto
**Objetivo:** Facilitar la navegación manual de términos exactos dentro del documento visualizado.
1. **Interfaz de búsqueda:** Añadir un input de búsqueda y botones de navegación de ocurrencias (anterior/siguiente) en la barra de herramientas del visor.
2. **Integración con PDFFindController:** Inicializar el controlador de búsqueda nativo de PDF.js.
3. **Resaltado y navegación:** Conectar el input al controlador de búsqueda para resaltar los términos y desplazar la vista automáticamente a la ocurrencia seleccionada.