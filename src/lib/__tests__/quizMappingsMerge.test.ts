import { describe, it, expect } from 'vitest';
import {
  mergeMappingsWithBulkSelection,
  mappingKey,
  type ItembankMappingLike,
  type BulkResultLike,
} from '../quizMappingsMerge';

interface Mapping extends ItembankMappingLike {
  id?: string;
}

describe('mergeMappingsWithBulkSelection', () => {
  it('returns the existing mappings untouched when there are no bulk results', () => {
    const mappings: Mapping[] = [
      { id: 'a', concept_id: 'c1', exsection_path: ['stats', 'mean'] },
    ];
    const { merged, additions } = mergeMappingsWithBulkSelection(mappings, null, new Set());
    expect(merged).toBe(mappings);
    expect(additions).toEqual([]);
  });

  it('merges selected bulk candidates with existing mappings without duplicates', () => {
    const mappings: Mapping[] = [
      { id: 'a', concept_id: 'c1', exsection_path: ['stats', 'mean'] },
    ];
    const bulkResults: BulkResultLike[] = [
      {
        conceptId: 'c1',
        candidates: [{ exsection_path: ['stats', 'median'] }],
      },
      {
        conceptId: 'c2',
        candidates: [{ exsection_path: ['prob', 'bayes'] }],
      },
    ];
    const selected = new Set([
      mappingKey('c1', ['stats', 'median']),
      mappingKey('c2', ['prob', 'bayes']),
    ]);

    const { merged, additions } = mergeMappingsWithBulkSelection(mappings, bulkResults, selected);

    expect(additions).toEqual([
      { concept_id: 'c1', exsection_path: ['stats', 'median'] },
      { concept_id: 'c2', exsection_path: ['prob', 'bayes'] },
    ]);
    expect(merged).toHaveLength(3);
    // Existing mapping is preserved (including its id)
    expect(merged[0]).toEqual({ id: 'a', concept_id: 'c1', exsection_path: ['stats', 'mean'] });
    // No duplicates: each (concept, path) appears once
    const keys = merged.map(m => mappingKey(m.concept_id, m.exsection_path));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not re-add candidates that are already linked in the existing mappings', () => {
    const mappings: Mapping[] = [
      { id: 'a', concept_id: 'c1', exsection_path: ['stats', 'mean'] },
    ];
    const bulkResults: BulkResultLike[] = [
      {
        conceptId: 'c1',
        candidates: [
          { exsection_path: ['stats', 'mean'] }, // already linked
          { exsection_path: ['stats', 'median'] }, // new
        ],
      },
    ];
    const selected = new Set([
      mappingKey('c1', ['stats', 'mean']),
      mappingKey('c1', ['stats', 'median']),
    ]);

    const { merged, additions } = mergeMappingsWithBulkSelection(mappings, bulkResults, selected);

    expect(additions).toEqual([
      { concept_id: 'c1', exsection_path: ['stats', 'median'] },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('ignores candidates that are not green-checked (not in the selection set)', () => {
    const mappings: Mapping[] = [];
    const bulkResults: BulkResultLike[] = [
      {
        conceptId: 'c1',
        candidates: [
          { exsection_path: ['stats', 'median'] },
          { exsection_path: ['stats', 'mode'] },
        ],
      },
    ];
    const selected = new Set([mappingKey('c1', ['stats', 'median'])]);

    const { merged, additions } = mergeMappingsWithBulkSelection(mappings, bulkResults, selected);

    expect(additions).toEqual([
      { concept_id: 'c1', exsection_path: ['stats', 'median'] },
    ]);
    expect(merged).toHaveLength(1);
  });

  it('deduplicates the same candidate appearing in multiple bulk results', () => {
    const mappings: Mapping[] = [];
    const bulkResults: BulkResultLike[] = [
      { conceptId: 'c1', candidates: [{ exsection_path: ['stats', 'median'] }] },
      { conceptId: 'c1', candidates: [{ exsection_path: ['stats', 'median'] }] },
    ];
    const selected = new Set([mappingKey('c1', ['stats', 'median'])]);

    const { merged, additions } = mergeMappingsWithBulkSelection(mappings, bulkResults, selected);

    expect(additions).toHaveLength(1);
    expect(merged).toHaveLength(1);
  });

  it('preserves manual edits/new mappings already in the payload', () => {
    const mappings: Mapping[] = [
      { concept_id: 'c1', exsection_path: ['manual', 'added'] }, // manually added, no id
      { id: 'srv', concept_id: 'c2', exsection_path: ['from', 'server'] },
    ];
    const bulkResults: BulkResultLike[] = [
      { conceptId: 'c3', candidates: [{ exsection_path: ['bulk', 'new'] }] },
    ];
    const selected = new Set([mappingKey('c3', ['bulk', 'new'])]);

    const { merged } = mergeMappingsWithBulkSelection(mappings, bulkResults, selected);

    expect(merged).toEqual([
      { concept_id: 'c1', exsection_path: ['manual', 'added'] },
      { id: 'srv', concept_id: 'c2', exsection_path: ['from', 'server'] },
      { concept_id: 'c3', exsection_path: ['bulk', 'new'] },
    ]);
  });

  it('does not mutate the original mappings array when there are additions', () => {
    const mappings: Mapping[] = [
      { id: 'a', concept_id: 'c1', exsection_path: ['stats', 'mean'] },
    ];
    const bulkResults: BulkResultLike[] = [
      { conceptId: 'c1', candidates: [{ exsection_path: ['stats', 'median'] }] },
    ];
    const selected = new Set([mappingKey('c1', ['stats', 'median'])]);

    mergeMappingsWithBulkSelection(mappings, bulkResults, selected);

    expect(mappings).toHaveLength(1);
  });
});
