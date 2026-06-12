-- Vervang de ivfflat-index op document_chunks.embedding door een HNSW-index.
--
-- Waarom: de oude index `USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')`
-- was voor de huidige corpus (honderden chunks) verkeerd afgesteld. ivfflat verdeelt
-- de vectoren in `lists` clusters en doorzoekt standaard maar `ivfflat.probes = 1`
-- cluster per query. Met 100 clusters over een paar honderd rijen bevat elk cluster
-- maar enkele vectoren, waardoor een willekeurige zoekvector vaak een (bijna) leeg
-- cluster raakt en `match_document_chunks` ZERO treffers teruggeeft — terwijl een
-- exacte scan wel relevante chunks vindt (similarity tot ~0.58). RAG-zoek (chat,
-- explain, quiz, project) faalde hierdoor stil.
--
-- HNSW geeft hoge recall met de standaardinstellingen (geen probe-tuning nodig) en
-- schaalt goed mee als de corpus groeit. De vectorruimte (1536 dim, cosine) blijft
-- gelijk, dus geen re-embed nodig.
DROP INDEX IF EXISTS document_chunks_embedding_idx;

CREATE INDEX document_chunks_embedding_idx
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops);
