import { describe, it, expect } from 'vitest';
import { pickReusableRagFolder } from '../ragFolder.js';

describe('pickReusableRagFolder', () => {
  const courseA = 'course-a';
  const courseB = 'course-b';

  it('hergebruikt een niet-gekoppelde naam-match', () => {
    const id = pickReusableRagFolder({
      folders: [{ id: 'f1' }],
      assignmentsByFolderId: { f1: [] },
      courseId: courseA,
    });
    expect(id).toBe('f1');
  });

  it('hergebruikt een map die alleen aan déze cursus hangt', () => {
    const id = pickReusableRagFolder({
      folders: [{ id: 'f1' }],
      assignmentsByFolderId: { f1: [courseA] },
      courseId: courseA,
    });
    expect(id).toBe('f1');
  });

  it('weigert (security) een naam-match die aan een ándere cursus hangt', () => {
    // Kern van Task #334: docent van cursus A mag een map van cursus B niet
    // laten hergebruiken/koppelen via een botsende of gemanipuleerde naam.
    const id = pickReusableRagFolder({
      folders: [{ id: 'fB' }],
      assignmentsByFolderId: { fB: [courseB] },
      courseId: courseA,
    });
    expect(id).toBeNull();
  });

  it('slaat een map over die (ook) aan een andere cursus hangt en pakt een veilige', () => {
    const id = pickReusableRagFolder({
      folders: [{ id: 'fShared' }, { id: 'fFree' }],
      assignmentsByFolderId: { fShared: [courseB, courseA], fFree: [] },
      courseId: courseA,
    });
    // fShared hangt óók aan B → niet veilig; fFree is vrij → die wint.
    expect(id).toBe('fFree');
  });

  it('geeft null bij geen kandidaten of ontbrekende courseId', () => {
    expect(pickReusableRagFolder({ folders: [], assignmentsByFolderId: {}, courseId: courseA })).toBeNull();
    expect(pickReusableRagFolder({ folders: [{ id: 'f1' }], assignmentsByFolderId: { f1: [] }, courseId: '' })).toBeNull();
  });
});
