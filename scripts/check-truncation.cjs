const fs = require('node:fs');
const zlib = require('node:zlib');
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/data/db/kompl.db', { readonly: true });

console.log('=== Text / tweet source rows ===');
const rows = db.prepare(`
  SELECT source_id, title, source_type, file_path, date_ingested
  FROM sources
  WHERE source_type IN ('text', 'tweet', 'twitter')
  ORDER BY date_ingested DESC
`).all();
console.log('count:', rows.length);

let suspects = 0;
for (const r of rows) {
  if (!r.file_path) continue;
  let raw;
  try {
    const buf = fs.readFileSync(r.file_path);
    raw = r.file_path.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  } catch (e) { continue; }
  const trimmed = raw.trim();
  const len = trimmed.length;
  const endsTco = /https?:\/\/t\.co\/[A-Za-z0-9]+\s*$/.test(trimmed);
  const endsEllipsis = /[\u2026…]\s*(?:https?:\/\/\S+)?\s*$/.test(trimmed);
  const isTweetish = /^\*\*@/.test(trimmed) || /^@[A-Za-z0-9_]+:/.test(trimmed) || r.source_type === 'tweet';
  const suspicious = endsTco || endsEllipsis;
  if (suspicious) suspects++;
  if (suspicious || (isTweetish && len < 400)) {
    const tail = trimmed.slice(-180).replace(/\n/g, ' ');
    const head = trimmed.slice(0, 80).replace(/\n/g, ' ');
    console.log(`  [${r.source_type}] len=${len} tco=${endsTco} ell=${endsEllipsis}`);
    console.log(`    head: ${head}`);
    console.log(`    tail: ...${tail}`);
  }
}
console.log('truncation suspects:', suspects, '/', rows.length);

console.log('');
console.log('=== saved_link_no_content failures ===');
const f = db.prepare(`
  SELECT source_url, title_hint, source_type, metadata, date_saved
  FROM ingest_failures WHERE error = 'saved_link_no_content'
  ORDER BY date_saved DESC
`).all();
console.log('count:', f.length);
for (const x of f) {
  console.log(`  ${x.source_type} | ${x.source_url}`);
  console.log(`    title_hint: ${x.title_hint}`);
  console.log(`    metadata: ${(x.metadata || '').slice(0, 300)}`);
}
