import { pool } from './src/config/db.js';

const label = (s) => { console.log(`\n== ${s} ==`); };

try {
  label('Paragraphs huerfanos (sin documento padre)');
  const orphan = await pool.query(`
    SELECT p.id, p.document_id, p.paragraph_index, p.created_at
    FROM document_paragraphs p
    LEFT JOIN documents d ON d.id = p.document_id
    WHERE d.id IS NULL
  `);
  console.log('count:', orphan.rowCount);
  console.table(orphan.rows);

  label('Documents huérfanos vacios (sin ningun paragraph)');
  const emptyDocs = await pool.query(`
    SELECT d.id, d.title, d.created_at, d.r2_key
    FROM documents d
    LEFT JOIN document_paragraphs p ON p.document_id = d.id
    WHERE p.id IS NULL
  `);
  console.log('count:', emptyDocs.rowCount);
  console.table(emptyDocs.rows);

  label('Ultimos 10 documentos (ordenados por fecha)');
  const docs = await pool.query(`
    SELECT d.id, d.title, d.created_at,
           (SELECT count(*) FROM document_paragraphs p WHERE p.document_id = d.id) AS n_paras
    FROM documents d
    ORDER BY d.created_at DESC
    LIMIT 10
  `);
  console.table(docs.rows);

  label('Totales');
  const totals = await pool.query(`
    SELECT
      (SELECT count(*) FROM documents) AS documents,
      (SELECT count(*) FROM document_paragraphs) AS paragraphs
  `);
  console.table(totals.rows);
} finally {
  await pool.end();
}