export interface ItembankMappingLike {
  concept_id: string;
  exsection_path: string[];
}

export interface BulkCandidateLike {
  exsection_path: string[];
}

export interface BulkResultLike {
  conceptId: string;
  candidates: BulkCandidateLike[];
}

export function mappingKey(conceptId: string, exsectionPath: string[]): string {
  return `${conceptId}|${exsectionPath.join('/')}`;
}

export function mergeMappingsWithBulkSelection<M extends ItembankMappingLike>(
  mappings: M[],
  bulkResults: BulkResultLike[] | null,
  bulkSelected: Set<string>,
): { merged: M[]; additions: M[] } {
  if (!bulkResults) {
    return { merged: mappings, additions: [] };
  }

  const additions: M[] = [];
  const has = (cid: string, pathKey: string) =>
    mappings.some(m => m.concept_id === cid && m.exsection_path.join('/') === pathKey) ||
    additions.some(m => m.concept_id === cid && m.exsection_path.join('/') === pathKey);

  for (const r of bulkResults) {
    for (const cand of r.candidates) {
      const pathKey = cand.exsection_path.join('/');
      if (!bulkSelected.has(`${r.conceptId}|${pathKey}`)) continue;
      if (!has(r.conceptId, pathKey)) {
        additions.push({ concept_id: r.conceptId, exsection_path: cand.exsection_path } as M);
      }
    }
  }

  const merged = additions.length > 0 ? [...mappings, ...additions] : mappings;
  return { merged, additions };
}
