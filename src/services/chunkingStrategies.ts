import { ChunkingService, PdfPage } from './chunkingService.js';
import { StrategyDetector } from './strategyDetector.js';
import { normativeOutline, outlinePathAt } from './chunking/normativeContext.js';

export type ChunkingStrategyName = 'generic' | 'legal';

/** Metadatos disponibles al momento de seleccionar una estrategia de chunking */
export interface ChunkingFileMetadata {
  /** Modo pedido (Automática / Genérica / Legal) */
  chunkingStrategy?: 'auto' | 'generic' | 'legal';
  /** Dominio/sector clasificado por el usuario o el sistema (ej: legal, técnico) */
  domain?: string;
  /** Tipo de archivo clasificado (ej: pdf_normativo) */
  fileType?: string;
  /** Extensión del archivo (ej: .md, .pdf) */
  fileExtension?: string;
  mimeType?: string;
  /** Fase 3: overlap entre child chunks (chars). Default 0 (sin regresión). */
  overlapChars?: number;
  /** Fase 7: tamaño adaptativo por densidad. Default false (tamaños fijos). */
  adaptive?: boolean;
}

/**
 * Configura opciones de fragmentación jerárquica (parent/child) con separadores
 * explícitos y limpieza previa opcional, específicos por dominio.
 */
export interface ChunkingStrategyConfig {
  name: ChunkingStrategyName;
  /** Tamaño de parent chunk (contexto completo entregado al LLM) */
  parentMaxChars: number;
  /** Tamaño de child chunk (fragmento optimizado para embedding) */
  childMaxChars: number;
  childMinChars: number;
  /** Limpieza previa opcional del texto antes de fragmentar */
  clean?: (text: string) => string;
  /**
   * Fase 7 (opcional): tamaño máx. por segmento (adaptativo por densidad).
   * Si se omite → `parent/childMaxChars` fijos (comportamiento actual, cero regresión).
   */
  sizeFor?: (segment: { text: string }) => number;
  /**
   * Parent chunks estructura-aware por ARTICULO (1 parent = 1 artículo, con sus
   * encabezados de sección adheridos). Si el texto no tiene ARTICULO/ANEXO se
   * cae al particionado por tamaño habitual (cero regresión).
   */
  articleAware?: boolean;
}

/**
 * Resultado de preparar el texto: el texto limpio más un mapa que traduce un
 * offset del texto preparado a un offset del texto ORIGINAL. Así la ubicación
 * del fragmento (línea/página/bbox) siempre queda referida al archivo fuente.
 */
export interface PreparedText {
  text: string;
  index: (offset: number) => number;
}

/** Estrategia de chunking: aplica la config y limpia el texto antes de fragmentar. */
export interface ChunkingStrategy {
  readonly config: ChunkingStrategyConfig;
  prepare(text: string): PreparedText;
}

/**
 * Estrategia genérica multipropósito: para cualquier documento no clasificado
 * (reportes, PDFs estándar, TXT). Tamaño moderado, separación por párrafos/oraciones.
 */
export class GenericChunkingStrategy implements ChunkingStrategy {
  readonly config: ChunkingStrategyConfig = {
    name: 'generic',
    parentMaxChars: 2500, // ~700 tokens para el contexto del LLM
    childMaxChars: 1000,  // ~250 tokens para embeddings densos
    childMinChars: 150,
  };

  prepare(text: string): PreparedText {
    return { text, index: (i) => i };
  }
}

/** Línea estructural del documento legal: su salto de línea debe conservarse
 *  para que el detector de fronteras (por líneas) y el outline la vean. */
const STRUCTURAL_LINE_RE =
  /^(\d{1,4}[.)]|[a-z]{1,2}\)|[ivxlcdm]{2,8}[.)]|art(?:[ií]culo|iculo)?\.?\s*\d+|#{1,6}\s+|[-*•·]\s+|(?:T[IÍ]TULO|CAP[IÍ]TULO|SECCI[OÓ]N|ANEXO|PARTE|LEY|DECRETO|DISPOSICIONES?)\b|[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ]{3,48}:)/i;

/**
 * Estrategia especializada en normativas/leyes/PDFs legales.
 * - Primero limpia el texto reconstruyendo palabras cortadas por saltos de página.
 * - Usa tamaños de chunk más grandes para no cortar definiciones ni incisos completos.
 */
export class LegalNormChunkingStrategy implements ChunkingStrategy {
  readonly config: ChunkingStrategyConfig = {
    name: 'legal',
    parentMaxChars: 3500, // ~1000 tokens para la ventana de contexto del LLM
    childMaxChars: 1200,  // ~300-350 tokens para embeddings semánticos densos
    childMinChars: 150,
    // Parent chunks estructura-aware: un parent por ARTICULO (con sus títulos
    // de sección adheridos). Sub-división interna solo si el artículo excede
    // parentMaxChars.
    articleAware: true,
    clean: (t) => this.cleanWithMap(t).text,
  };

  prepare(text: string): PreparedText {
    return this.cleanWithMap(text);
  }

  /**
   * Reconstruye palabras cortadas por saltos de página o guiones del PDF antes
   * de fragmentar (ej. "perso-\nnales" → "personales"). A la vez produce un mapa
   * offset(preparado) → offset(original) para que la ubicación de cada fragmento
   * siga referida al texto original.
   */
  private cleanWithMap(text: string): PreparedText {
    const out: string[] = [];
    const src: number[] = [];
    const L = text.length;
    const isW = (ch: string | undefined) => !!ch && /\w/.test(ch);

    let i = 0;
    while (i < L) {
      const ch = text[i];
      const prevW = i > 0 && isW(text[i - 1]);

      if (ch === '-') {
        let k = i + 1;
        while (k < L && text[k] === ' ') k++;
        if (k < L && text[k] === '\n') {
          let m = k + 1;
          while (m < L && text[m] === ' ') m++;
          if (prevW && m < L && isW(text[m])) { i = m; continue; } // unir: "- \n " → nada
          out.push('-'); src.push(i); i = i + 1; continue; // guion sin unión
        }
        out.push(ch); src.push(i); i = i + 1; continue; // guion normal
      }

      if (ch === '\n') {
        const prevNL = i > 0 && text[i - 1] === '\n';
        const nextNL = i + 1 < L && text[i + 1] === '\n';
        if (prevNL || nextNL) { out.push('\n'); src.push(i); i += 1; continue; } // párrafo

        // Conservar el salto de línea si la línea ANTERIOR es estructural ("ANEXO I"
        // seguido de "Planilla...", "TITULO II - ..." seguido de su subtítulo): sin
        // esto el texto siguiente se pega a la línea del encabezado ("ANEXO IPlanilla")
        // y el outline/el regex deja de reconocer el nodo.
        const prevLineStart = text.lastIndexOf('\n', i - 1) + 1;
        if (STRUCTURAL_LINE_RE.test(text.slice(prevLineStart, i).trim())) {
          out.push('\n'); src.push(i); i += 1; continue;
        }

        // Conservar el salto de línea si la línea siguiente es ESTRUCTURAL (ARTICULO,
        // numeración, inciso a), encabezado, ítem de lista). Sin esto, colapsar el \n
        // en espacio haría que el detector de fronteras (que es POR LÍNEA) ya no viera
        // el inicio de cada artículo/inciso y absorbiera el título dentro del chunk
        // anterior.
        let k = i + 1;
        while (k < L && (text[k] === ' ' || text[k] === '\t')) k++;
        const lineEnd = text.indexOf('\n', k);
        const line = text.slice(k, lineEnd < 0 ? Math.min(L, k + 60) : lineEnd).trim();
        if (STRUCTURAL_LINE_RE.test(line)) {
          out.push('\n'); src.push(i); i += 1; continue;
        }

        // (Este branch quedó deliberadamente vacío: un \n DESNUDO entre letras
        // es un salto de línea real que el extractor marca por geometría; unirlo
        // sin espacio pegaba palabras ("personales\ntratamiento" → "personalesasentados").
        // La partición de palabra con guión visible ("perso-\nnales") se une arriba.)

        // Salto de línea simple dentro de un párrafo → espacio. Antes se eliminaba
        // cuando iba entre dos letras, pegando palabras ("datos personales" →
        // "personalesasentados") y borrando los saltos que detectan las fronteras.
        out.push(' '); src.push(i); i += 1; continue;
      }

      out.push(ch); src.push(i); i += 1;
    }

    // trim: quitar espacios del borde manteniendo alineado el mapa
    let a = 0;
    let b = out.length;
    while (a < b && out[a] === ' ') a++;
    while (b > a && out[b - 1] === ' ') b--;
    const clipped = out.slice(a, b);
    const srcClip = src.slice(a, b);

    return {
      text: clipped.join(''),
      index: (c: number) => {
        if (srcClip.length === 0) return text.length;
        if (c <= 0) return srcClip[0];
        if (c >= srcClip.length) return srcClip[srcClip.length - 1] + 1;
        return srcClip[c] ?? text.length;
      },
    };
  }
}

/**
 * Selector de estrategia de chunking según los metadatos o la extensión del archivo.
 * Prioriza estrategias especializadas y cae al fallback genérico.
 */
export class ChunkingStrategySelector {
  getStrategy(metadata: ChunkingFileMetadata): ChunkingStrategy {
    const { domain, fileType, fileExtension, mimeType } = metadata;

    // 1. Documento clasificado como normativo/legal
    if (
      domain === 'legal' ||
      fileType === 'pdf_normativo' ||
      /ley|norma|decreto|regulaci/i.test(domain ?? '')
    ) {
      return new LegalNormChunkingStrategy();
    }

    // 2. Markdown / documentación técnica (futura extensión → genérico por ahora)
    if (fileExtension === '.md') {
      return new GenericChunkingStrategy();
    }

    // Cierre de regla para mimeType histórico (documentos legales en PDF)
    if (/pdf/i.test(mimeType ?? '') && /legal|norma|ley/i.test(fileExtension ?? '')) {
      return new LegalNormChunkingStrategy();
    }

    // 3. Fallback: estrategia genérica multipropósito
    return new GenericChunkingStrategy();
  }
}

export interface StrategySplittingOptions {
  parentMaxChars?: number;
  childMaxChars?: number;
  childMinChars?: number;
  /** Fase 3: caracteres de solape hacia atrás entre child chunks (~50–100). Default 0. */
  overlapChars?: number;
  /** Fase 7: tamaño máx. por segmento (adaptativo). Default: config de la estrategia. */
  sizeFor?: (segment: { text: string }) => number;
  pages?: PdfPage[];
  mimeType?: string;
}

/**
 * Resuelve la estrategia final a partir de la selección del usuario y, en modo
 * 'auto', del contenido del texto. Las opciones explícitas nunca se sobrescriben.
 * Con la detección por contenido determinista (heurística pura) disponible, cada
 * llamada crea su detector (sin estado, barato).
 */
export function resolveChunkingStrategy(
  metadata: ChunkingFileMetadata,
  text?: string
): { strategy: ChunkingStrategy; source: 'manual' | 'detected' | 'heuristic' } {
  // Explicitas (incluye compatibilidad con el flujo anterior por domain/fileType).
  const explicitLegal =
    metadata.chunkingStrategy === 'legal' ||
    metadata.domain === 'legal' ||
    metadata.fileType === 'pdf_normativo' ||
    /ley|norma|decreto|regulaci/i.test(metadata.domain ?? '');
  const explicitGeneric = metadata.chunkingStrategy === 'generic' || metadata.domain === 'general';

  if (explicitLegal) return { strategy: new LegalNormChunkingStrategy(), source: 'manual' };
  if (explicitGeneric) return { strategy: new GenericChunkingStrategy(), source: 'manual' };

  // Automática: clasificación por contenido.
  if (metadata.chunkingStrategy === 'auto' && text) {
    const detected = new StrategyDetector().detect(text);
    const strategy = detected.strategy === 'legal' ? new LegalNormChunkingStrategy() : new GenericChunkingStrategy();
    return { strategy, source: 'detected' };
  }

  // Compatibilidad con llamadas existentes (sin chunkingStrategy): heurística clásica.
  return { strategy: new ChunkingStrategySelector().getStrategy(metadata), source: 'heuristic' };
}

/**
 * Aplica una estrategia de chunking jerárquico sobre el texto usando el
 * ChunkingService subyacente. Limpia el texto según la estrategia y ajusta
 * los tamaños de parent/child según su config. La ubicación de cada fragmento
 * se recalcula contra el texto ORIGINAL (vía el mapa de la estrategia) para que
 * líneas / página / bbox estén alineados con el archivo que ve el usuario.
 */
export function splitWithStrategy(
  chunker: ChunkingService,
  text: string,
  strategy: ChunkingStrategy,
  opts: StrategySplittingOptions = {}
): ReturnType<ChunkingService['splitHierarchical']> {
  const prepared = strategy.prepare(text);
  const overlapChars = opts.overlapChars ?? 0;
  // No pasamos `pages` al split jerárquico: la ubicación real la resolvemos abajo
  // contra el texto original para no desalinear bbox al usar texto ya limpio.
  const parentMaxChars = opts.parentMaxChars ?? strategy.config.parentMaxChars;
  // Parent chunks por ARTICULO (estrategia legal): 1 parent = 1 artículo con sus
  // encabezados adheridos. `undefined` cuando no hay articulación → particionado
  // por tamaño habitual (cero regresión).
  const parentSlices = strategy.config.articleAware
    ? chunker.splitByArticles(prepared.text, { maxChars: parentMaxChars, mimeType: opts.mimeType })
    : undefined;
  const result = chunker.splitHierarchical(prepared.text, opts.mimeType ?? '', {
    parentMaxChars,
    childMaxChars: opts.childMaxChars ?? strategy.config.childMaxChars,
    childMinChars: opts.childMinChars ?? strategy.config.childMinChars,
    sizeFor: opts.sizeFor ?? strategy.config.sizeFor,
    parentSlices,
  });

  // Fase 6 — Contexto normativo: para la estrategia legal, reconstruir el outline
  // jerárquico y anclar cada child a su cadena de ancestros (sobre texto preparado).
  const outline = strategy.config.name === 'legal' ? normativeOutline(prepared.text) : [];

  const children = result.children.map(ch => {
    const loc = ch.location;
    if (!loc || loc.startChar == null || loc.endChar == null) return ch;

    const contextPath = outline.length > 0 ? outlinePathAt(outline, loc.startChar) : undefined;

    // Fase 3 — Overlap sobre el texto preparado, SOLO para enriquecer/vectorizar.
    // Fase 5/B — El fragmento publicado (`text` y `location`) queda como el NÚCLEO SIN
    // overlap, de modo que el visor resalte exactamente el contenido propio del chunk
    // (no la cola del anterior). El rango ampliado se expone aparte en `extendedText`
    // y NO afecta la ubicación ni las marcas del PDF.
    const extendedText = overlapChars > 0
      ? prepared.text.slice(Math.max(0, loc.startChar - overlapChars), loc.endChar)
      : ch.text;

    const located = chunker.locateOnOriginal(text, opts.pages, loc.startChar, loc.endChar, prepared.index, ch.text);
    // Core == rango publicado (sin overlap). Lo anotamos por compatibilidad con F5.
    if (located.startChar != null && located.endChar != null) {
      located.coreStartChar = located.startChar;
      located.coreEndChar = located.endChar;
    }

    return {
      ...ch,
      location: located,
      ...(extendedText !== ch.text ? { extendedText } : {}),
      ...(contextPath ? { contextPath } : {}),
    };
  });

  return { ...result, children };
}