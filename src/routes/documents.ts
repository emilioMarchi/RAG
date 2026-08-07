import { Router, Request, Response } from 'express';
import multer from 'multer';
import { IngestionPipeline } from '../services/ingestionPipeline.js';
import { ChunkingService } from '../services/chunkingService.js';
import { EmbeddingService } from '../services/embeddingService.js';
import { LLMService } from '../services/llmService.js';
import { R2StorageService } from '../services/r2Service.js';
import { query } from '../config/db.js';

const upload = multer({ storage: multer.memoryStorage() });

export function createDocumentRouter(
  pipeline: IngestionPipeline,
  chunker: ChunkingService
): Router {
  const router = Router();

  router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const title = req.body.title || req.file.originalname;
      const mimeType = req.file.mimetype;
      const fileBuffer = req.file.buffer;

      const tempPath = `temp_${Date.now()}_${req.file.originalname}`;
      const fs = await import('fs');
      fs.writeFileSync(tempPath, fileBuffer);
      const fullContentText = await chunker.extractText(tempPath, mimeType);
      fs.unlinkSync(tempPath);

      const paragraphs = chunker.splitIntoParagraphs(fullContentText);

      if (paragraphs.length === 0) {
        res.status(400).json({ error: 'No se pudo extraer contenido del archivo' });
        return;
      }

      const result = await pipeline.processAndStoreDocument({
        title,
        fileBuffer,
        fileName: req.file.originalname,
        mimeType,
        fullContentText,
        paragraphs,
      });

      res.status(201).json({
        message: 'Documento procesado exitosamente',
        ...result,
      });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({
        error: 'Error al procesar el documento',
        details: error instanceof Error ? `${error.message}\n${error.stack?.substring(0, 500)}` : 'Unknown error',
      });
    }
  });

  router.get('/documents', async (_req: Request, res: Response) => {
    try {
      const result = await query<{
        id: string;
        title: string;
        mime_type: string;
        created_at: string;
        paragraph_count: number;
      }>(
        `SELECT d.id, d.title, d.mime_type, d.created_at,
                COUNT(p.id)::int AS paragraph_count
         FROM documents d
         LEFT JOIN document_paragraphs p ON p.document_id = d.id
         GROUP BY d.id
         ORDER BY d.created_at DESC`
      );
      res.json(result.rows);
    } catch (error) {
      console.error('List documents error:', error);
      res.status(500).json({ error: 'Error al listar documentos' });
    }
  });

  router.delete('/documents/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const docRes = await query<{ r2_key: string }>(
        'SELECT r2_key FROM documents WHERE id = $1',
        [id]
      );

      if (docRes.rows.length === 0) {
        res.status(404).json({ error: 'Documento no encontrado' });
        return;
      }

      const r2Key = docRes.rows[0].r2_key;

      const r2Service = new R2StorageService();
      await r2Service.deleteFile(r2Key);

      await query('DELETE FROM documents WHERE id = $1', [id]);

      res.json({ message: 'Documento eliminado exitosamente' });
    } catch (error) {
      console.error('Delete error:', error);
      res.status(500).json({ error: 'Error al eliminar documento' });
    }
  });

  /**
   * GET /api/documents/:id/paragraphs
   * Devuelve todos los párrafos de un documento (para el grafo de nodos).
   */
  router.get('/documents/:id/paragraphs', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await query<{
        id: string;
        paragraph_index: number;
        raw_content: string;
        contextualized_text: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, paragraph_index, raw_content, contextualized_text, metadata
         FROM document_paragraphs
         WHERE document_id = $1
         ORDER BY paragraph_index ASC`,
        [id]
      );
      res.json(result.rows);
    } catch (error) {
      console.error('List paragraphs error:', error);
      res.status(500).json({ error: 'Error al obtener párrafos' });
    }
  });

  return router;
}
