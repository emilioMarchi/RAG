import { ChunkingService, PdfPage } from './chunkingService.js';
import { StrategyDetector } from './strategyDetector.js';

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
    parentMaxChars: 1000,
    childMaxChars: 450,
    childMinChars: 80,
  };

  prepare(text: string): PreparedText {
    return { text, index: (i) => i };
  }
}

/**
 * Estrategia especializada en normativas/leyes/PDFs legales.
 * - Primero limpia el texto reconstruyendo palabras cortadas por saltos de página.
 * - Usa tamaños de chunk más grandes para no cortar definiciones ni incisos completos.
 */
export class LegalNormChunkingStrategy implements ChunkingStrategy {
  readonly config: ChunkingStrategyConfig = {
    name: 'legal',
    parentMaxChars: 1500,
    childMaxChars: 600,
    childMinChars: 100,
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
        if (prevW && i + 1 < L && isW(text[i + 1])) { i += 1; continue; } // unir sin salto
        out.push(' '); src.push(i); i += 1; continue; // salto simple → espacio
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
  const result = chunker.splitHierarchical(prepared.text, opts.mimeType ?? '', {
    parentMaxChars: opts.parentMaxChars ?? strategy.config.parentMaxChars,
    childMaxChars: opts.childMaxChars ?? strategy.config.childMaxChars,
    childMinChars: opts.childMinChars ?? strategy.config.childMinChars,
  });

  const children = result.children.map(ch => {
    const loc = ch.location;
    if (!loc || loc.startChar == null || loc.endChar == null) return ch;

    // Fase 3 — Overlap: retroceder el inicio del child sobre el texto preparado
    // para incluir la cola del chunk anterior, sin perder contexto en el corte.
    // La ubicación (línea/página/bbox) se sigue recalculando contra el texto original.
    const extStart = Math.max(0, loc.startChar - overlapChars);
    const extEnd = loc.endChar;
    const textWithOverlap = overlapChars > 0 ? prepared.text.slice(extStart, extEnd) : ch.text;

    const located = chunker.locateOnOriginal(text, opts.pages, extStart, extEnd, prepared.index);

    // Fase 5 — Rango core vs extended: registrar también el rango útil del chunk SIN
    // overlap (en el texto original) para que el visor resalte el núcleo por defecto.
    if (overlapChars > 0) {
      const core = chunker.locateOnOriginal(text, opts.pages, loc.startChar, loc.endChar, prepared.index);
      if (core.startChar != null && core.endChar != null) {
        located.coreStartChar = core.startChar;
        located.coreEndChar = core.endChar;
      }
    }

    return {
      ...ch,
      text: textWithOverlap,
      location: located,
    };
  });

  return { ...result, children };
}