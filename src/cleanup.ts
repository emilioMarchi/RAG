import { query } from './config/db.js';
import { StorageService } from './services/r2Service.js';

/**
 * Limpieza de la base de datos (documentos + fragmentos + grafo + evaluaciones)
 * y de los archivos almacenados. Útil antes de re-ingestar con el nuevo formato
 * de `metadata.location` del DocumentContextViewer.
 */
async function main() {
  const storage = new StorageService();

  const before = await query<{ documents: number; paragraphs: number; evaluations: number }>(`
    SELECT
      (SELECT count(*) FROM documents)::int AS documents,
      (SELECT count(*) FROM document_paragraphs)::int AS paragraphs,
      (SELECT count(*) FROM query_evaluations)::int AS evaluations
  `);
  console.log('Antes:', before.rows[0]);

  // 1. Guardar las claves de archivo para borrarlas del almacenamiento
  const keysRes = await query<{ r2_key: string }>('SELECT r2_key FROM documents');
  const keys = keysRes.rows.map(r => r.r2_key);

  // 2. Borrar documentos (ON DELETE CASCADE elimina fragmentos, entidades y relaciones)
  await query('DELETE FROM documents');

  // 3. Evaluaciones de calidad (no tienen FK a documents)
  await query('DELETE FROM query_evaluations');

  // 4. Eliminar los archivos del almacenamiento (local/R2)
  for (const key of keys) {
    try {
      await storage.deleteFile(key);
    } catch (err) {
      console.warn(`No se pudo eliminar ${key}:`, err instanceof Error ? err.message : err);
    }
  }

  const after = await query<{ documents: number; paragraphs: number; evaluations: number }>(`
    SELECT
      (SELECT count(*) FROM documents)::int AS documents,
      (SELECT count(*) FROM document_paragraphs)::int AS paragraphs,
      (SELECT count(*) FROM query_evaluations)::int AS evaluations
  `);
  console.log('Después:', after.rows[0]);
  console.log(`Archivos eliminados: ${keys.length}`);
  console.log('Limpieza completada.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error en limpieza:', err);
    process.exit(1);
  });