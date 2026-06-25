-- Task #394: scope de vector-zoekfunctie op documentniveau zodat de
-- kandidaten VÓÓR de LIMIT uit de juiste cursus komen, niet uit een globale
-- top-N over de hele corpus. Zonder filter crowdde een grote multi-cursus-
-- corpus (1381 chunks, 111 docs) de eigen chunks van een cursus weg: een losse
-- figuur-caption moest ~1000 broer-chunks verslaan om in het 15-brede venster
-- te komen.
--
-- We voegen een optionele parameter `filter_document_ids uuid[]` toe (default
-- NULL = oud globaal gedrag, backward compatible). Daarnaast verhogen we
-- `hnsw.ef_search` binnen de functie: bij een gefilterde HNSW-scan moet de
-- index meer kandidaten bekijken om genoeg in-filter treffers te vinden.

DROP FUNCTION IF EXISTS match_document_chunks(vector, float, int);

CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5,
  filter_document_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  content text,
  similarity float,
  document_title text,
  metadata jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Hogere ef_search verbetert de recall van de (eventueel gefilterde) HNSW-scan.
  PERFORM set_config('hnsw.ef_search', '200', true);

  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity,
    d.title AS document_title,
    dc.metadata
  FROM document_chunks dc
  JOIN documents d ON d.id = dc.document_id
  WHERE 1 - (dc.embedding <=> query_embedding) > match_threshold
    AND (filter_document_ids IS NULL OR dc.document_id = ANY(filter_document_ids))
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
