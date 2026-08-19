const { Pool } = require('pg');

// Read env manually
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Pool error:', err);
  process.exit(-1);
});

async function main() {
  try {
    // 1. List documents with paragraph counts
    console.log('=== DOCUMENTS ===');
    const docResult = await pool.query(`
      SELECT d.id, d.title, d.mime_type,
             COUNT(p.id)::int AS paragraph_count
      FROM documents d
      LEFT JOIN document_paragraphs p ON p.document_id = d.id
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `);
    docResult.rows.forEach((r) => {
      console.log('ID: ' + r.id + ', Title: ' + r.title + ', Paragraphs: ' + r.paragraph_count);
    });

    // 2. Show parent chunks
    console.log('\n=== PARENT CHUNKS ===');
    const parentResult = await pool.query(`
      SELECT id, parent_index, content, start_child_index, end_child_index, document_id
      FROM document_parent_chunks
      ORDER BY parent_index ASC
    `);
    parentResult.rows.forEach((r) => {
      console.log('Parent ID: ' + r.id + ', Index: ' + r.parent_index + ', Content len: ' + (r.content?.length || 0) + ', Children range: [' + r.start_child_index + ', ' + r.end_child_index + ']');
      // Show first 200 chars of content
      if (r.content) {
        console.log('  Content preview: ' + r.content.substring(0, 200).replace(/\n/g, ' '));
      }
    });

    // 3. Show child chunks with parent_chunk_id
    console.log('\n=== CHILD CHUNKS (first 10) ===');
    const childResult = await pool.query(`
      SELECT id, paragraph_index, raw_content, contextualized_text, parent_chunk_id, metadata
      FROM document_paragraphs
      ORDER BY paragraph_index ASC
      LIMIT 10
    `);
    childResult.rows.forEach((r) => {
      console.log('Child ID: ' + r.id + ', Paragraph: ' + r.paragraph_index + ', Parent: ' + r.parent_chunk_id);
      console.log('  raw_content preview: ' + (r.raw_content?.substring(0, 150) || 'N/A').replace(/\n/g, ' ') + '...');
      console.log('  ctx preview: ' + (r.contextualized_text?.substring(0, 150) || 'N/A').replace(/\n/g, ' ') + '...');
      // Parse metadata contextPath if exists
      if (r.metadata && r.metadata.contextPath) {
        console.log('  contextPath: ' + r.metadata.contextPath);
      }
    });

    // 4. Show distribution of parent_chunk_id null vs having value
    console.log('\n=== DISTRIBUTION: parent_chunk_id null vs value ===');
    const distResult = await pool.query(`
      SELECT 
        CASE WHEN parent_chunk_id IS NULL THEN 'NULL' ELSE 'HA VALUE' END AS status,
        COUNT(*) AS count
      FROM document_paragraphs
      GROUP BY parent_chunk_id IS NULL
      ORDER BY parent_chunk_id IS NULL
    `);
    distResult.rows.forEach((r) => {
      console.log('parent_chunk_id ' + r.status + ': ' + r.count + ' chunks');
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

main();