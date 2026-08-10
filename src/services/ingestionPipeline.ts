import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { StorageService } from './r2Service.js';
import { ChunkingService } from './chunkingService.js';
import { getClient } from '../config/db.js';
import { mapConcurrent } from '../utils/concurrency.js';

export class IngestionPipeline {
  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService,
    private storage: StorageService,
    private chunker: ChunkingService = new ChunkingService()
  ) {}

  async processAndStoreDocument(params: {
    title: string;
    fileBuffer: Buffer;
    fileName: string;
    mimeType: string;
    fullContentText: string;
    /** @deprecated Use fullContentText; se ignora si se usa chunking jerárquico */
    paragraphs?: string[];
  }) {
    const { title, fileBuffer, fileName, mimeType, fullContentText } = params;

    const client = await getClient();

    try {
      await client.query('BEGIN');

      // 1. Guardar archivo binario en Cloudflare R2
      const uploadResult = await this.storage.uploadFile(fileBuffer, fileName, mimeType);

      // 2. Vector Base 768d para el documento completo
      const baseVector = await this.embedder.generateEmbedding(fullContentText, 768);

      // 3. Persistir documento principal
      const docRes = await client.query(
        `INSERT INTO documents (title, content, r2_key, r2_url, mime_type, embedding_base)
         VALUES ($1, $2, $3, $4, $5, $6::vector) RETURNING id`,
        [title, fullContentText, uploadResult.key, uploadResult.publicUrl, mimeType, JSON.stringify(baseVector)]
      );
      const docId = docRes.rows[0].id;
      const docSummary = this.generateDocSummary(fullContentText);

      // 4. Chunking jerárquico: parent chunks + child chunks
      const { parents, children } = this.chunker.splitHierarchical(fullContentText, mimeType);

      // 5. Almacenar parent chunks y obtener sus IDs de DB
      const parentDbIds: string[] = [];
      for (const parent of parents) {
        const res = await client.query(
          `INSERT INTO document_parent_chunks
             (document_id, parent_index, content, start_child_index, end_child_index)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [docId, parent.parentIndex, parent.text, parent.startChildIndex, parent.endChildIndex]
        );
        parentDbIds.push(res.rows[0].id);
      }

      // 6. Enriquecer, vectorizar y extraer entidades de cada child chunk en paralelo
      const enrichedChildren = await mapConcurrent(
        children,
        async (child) => {
          const enriched = await this.llm.enrichChunk(title, docSummary, child.text);
          const ctxText = enriched.contextualized_text || child.text;
          const highVector = await this.embedder.generateEmbedding(ctxText, 1536);
          
          let graphData: {
            entities: Array<{ name: string; type: string }>;
            relations: Array<{ source_entity: string; target_entity: string; relation_type: string }>;
          } = { entities: [], relations: [] };
          try {
            graphData = await this.llm.extractEntitiesAndRelations(title, child.text);
          } catch (err) {
            console.error(`[Ingestion] Failed to extract entities for child ${child.childIndex}:`, err);
          }

          return {
            childIndex: child.childIndex,
            parentChunkId: parentDbIds[child.parentIndex] ?? null,
            rawText: child.text,
            contextualized_text: ctxText,
            keywords: enriched.keywords || [],
            category: enriched.category || 'general',
            highVector,
            graphData,
          };
        },
        5
      );

      // 7. Persistir child chunks y sus relaciones de entidad en DB
      for (const ec of enrichedChildren) {
        const pRes = await client.query(
          `INSERT INTO document_paragraphs
             (document_id, paragraph_index, raw_content, contextualized_text, metadata, embedding_high, parent_chunk_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, $7) RETURNING id`,
          [
            docId,
            ec.childIndex,
            ec.rawText,
            ec.contextualized_text,
            JSON.stringify({ keywords: ec.keywords, category: ec.category }),
            JSON.stringify(ec.highVector),
            ec.parentChunkId,
          ]
        );
        const paragraphId = pRes.rows[0].id;

        // Persistir Entidades encontradas en el fragmento
        const entityMap = new Map<string, string>();
        for (const ent of ec.graphData.entities) {
          const key = (ent.name ?? '').toLowerCase().trim();
          if (!key) continue;

          const entRes = await client.query(
            `INSERT INTO document_entities (document_id, paragraph_id, entity_name, entity_type)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [docId, paragraphId, ent.name, ent.type ?? 'entity']
          );
          entityMap.set(key, entRes.rows[0].id);
        }

        // Persistir Relaciones entre entidades del fragmento
        for (const rel of ec.graphData.relations) {
          const sourceKey = (rel.source_entity ?? '').toLowerCase().trim();
          const targetKey = (rel.target_entity ?? '').toLowerCase().trim();
          
          const sourceId = entityMap.get(sourceKey);
          const targetId = entityMap.get(targetKey);

          if (sourceId && targetId) {
            await client.query(
              `INSERT INTO entity_relations (source_entity_id, target_entity_id, relation_type, context_paragraph_id)
               VALUES ($1, $2, $3, $4)`,
              [sourceId, targetId, rel.relation_type ?? '', paragraphId]
            );
          }
        }
      }

      await client.query('COMMIT');

      return {
        docId,
        r2Key: uploadResult.key,
        parentChunksStored: parents.length,
        childChunksStored: children.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private generateDocSummary(text: string, maxChars: number = 500): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars).replace(/\s+\S*$/, '') + '...';
  }
}
