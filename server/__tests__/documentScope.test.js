import { describe, it, expect } from 'vitest';
import { computeTeacherFolderScope } from '../documentScope.js';

// Mappenmodel zoals de cursus-aanmaak het opzet (zie documentScope.js):
//   root → cursus-map(course) → RAG(rag_sources) / Data(data) / Uploads(uploads)
// course_folder_assignments koppelt course_id ALLEEN aan de 3 submappen.
function courseTree(prefix, courseFolderType = 'course') {
  return [
    { id: `${prefix}-course`, parent_folder_id: 'root', folder_type: courseFolderType, is_root: false },
    { id: `${prefix}-rag`, parent_folder_id: `${prefix}-course`, folder_type: 'rag_sources', is_root: false },
    { id: `${prefix}-data`, parent_folder_id: `${prefix}-course`, folder_type: 'data', is_root: false },
    { id: `${prefix}-uploads`, parent_folder_id: `${prefix}-course`, folder_type: 'uploads', is_root: false },
  ];
}

const ROOT = { id: 'root', parent_folder_id: null, folder_type: 'root', is_root: true };

describe('computeTeacherFolderScope', () => {
  it('geeft lege set zonder gekoppelde mappen', () => {
    const folders = [ROOT, ...courseTree('a')];
    expect(computeTeacherFolderScope([], folders).size).toBe(0);
    expect(computeTeacherFolderScope(null, folders).size).toBe(0);
  });

  it('omvat de eigen cursus-shell + alle submappen', () => {
    const folders = [ROOT, ...courseTree('a')];
    const assigned = ['a-rag', 'a-data', 'a-uploads'];
    const scope = computeTeacherFolderScope(assigned, folders);
    expect(scope.has('a-course')).toBe(true);
    expect(scope.has('a-rag')).toBe(true);
    expect(scope.has('a-data')).toBe(true);
    expect(scope.has('a-uploads')).toBe(true);
    // nooit de globale root
    expect(scope.has('root')).toBe(false);
  });

  it('sluit mappen van een ANDERE cursus uit', () => {
    const folders = [ROOT, ...courseTree('a'), ...courseTree('b')];
    const assigned = ['a-rag', 'a-data', 'a-uploads'];
    const scope = computeTeacherFolderScope(assigned, folders);
    expect(scope.has('b-course')).toBe(false);
    expect(scope.has('b-rag')).toBe(false);
    expect(scope.has('b-uploads')).toBe(false);
  });

  it('omvat door de docent later aangemaakte submappen (BFS-nakomelingen)', () => {
    const folders = [
      ROOT,
      ...courseTree('a'),
      { id: 'a-rag-sub', parent_folder_id: 'a-rag', folder_type: 'general', is_root: false },
      { id: 'a-rag-sub-deep', parent_folder_id: 'a-rag-sub', folder_type: 'general', is_root: false },
      { id: 'a-course-extra', parent_folder_id: 'a-course', folder_type: 'general', is_root: false },
    ];
    const scope = computeTeacherFolderScope(['a-rag', 'a-data', 'a-uploads'], folders);
    expect(scope.has('a-rag-sub')).toBe(true);
    expect(scope.has('a-rag-sub-deep')).toBe(true);
    // map direct onder de cursus-shell (zus van RAG/Data/Uploads) is ook bereikbaar
    expect(scope.has('a-course-extra')).toBe(true);
  });

  it('escaleert NIET naar root als de ouder van een gekoppelde map de root is', () => {
    // Foutieve koppeling: submap hangt direct onder de globale root i.p.v. een cursus-map.
    const folders = [
      ROOT,
      { id: 'orphan-rag', parent_folder_id: 'root', folder_type: 'rag_sources', is_root: false },
      ...courseTree('b'), // andere cursus, ook onder root
    ];
    const scope = computeTeacherFolderScope(['orphan-rag'], folders);
    // De map zelf blijft in scope, maar root en alles eronder NIET.
    expect(scope.has('orphan-rag')).toBe(true);
    expect(scope.has('root')).toBe(false);
    expect(scope.has('b-course')).toBe(false);
    expect(scope.has('b-rag')).toBe(false);
  });

  it('escaleert NIET als de ouder wel folder_type=course heeft maar is_root=true', () => {
    const folders = [
      { id: 'weird-root', parent_folder_id: null, folder_type: 'course', is_root: true },
      { id: 'weird-rag', parent_folder_id: 'weird-root', folder_type: 'rag_sources', is_root: false },
      { id: 'weird-sibling', parent_folder_id: 'weird-root', folder_type: 'data', is_root: false },
    ];
    const scope = computeTeacherFolderScope(['weird-rag'], folders);
    expect(scope.has('weird-rag')).toBe(true);
    expect(scope.has('weird-root')).toBe(false);
    expect(scope.has('weird-sibling')).toBe(false);
  });

  it('vereent meerdere cursussen voor een docent', () => {
    const folders = [ROOT, ...courseTree('a'), ...courseTree('b')];
    const scope = computeTeacherFolderScope(['a-rag', 'b-uploads'], folders);
    expect(scope.has('a-course')).toBe(true);
    expect(scope.has('a-rag')).toBe(true);
    expect(scope.has('b-course')).toBe(true);
    expect(scope.has('b-uploads')).toBe(true);
    expect(scope.has('b-rag')).toBe(true); // via de cursus-shell van B
    expect(scope.has('root')).toBe(false);
  });

  it('negeert onbekende/ontbrekende gekoppelde folder-ids', () => {
    const folders = [ROOT, ...courseTree('a')];
    const scope = computeTeacherFolderScope(['a-rag', 'does-not-exist', null], folders);
    expect(scope.has('a-rag')).toBe(true);
    expect(scope.has('a-course')).toBe(true);
    expect(scope.has('does-not-exist')).toBe(false);
  });
});
