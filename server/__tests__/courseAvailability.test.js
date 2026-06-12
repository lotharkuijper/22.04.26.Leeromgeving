import { describe, it, expect } from 'vitest';
import {
  authorizeAvailabilityChange,
  parseStudentVisible,
  memberCanAccessCourse,
  canAccessCourseContent,
} from '../courseAvailability.js';

describe('authorizeAvailabilityChange', () => {
  it('staat admin altijd toe (elke cursus)', () => {
    expect(authorizeAvailabilityChange({ isAdmin: true, isCourseTeacher: false })).toEqual({ allowed: true });
  });
  it('staat per-cursus docent van déze cursus toe', () => {
    expect(authorizeAvailabilityChange({ isAdmin: false, isCourseTeacher: true })).toEqual({ allowed: true });
  });
  it('weigert non-admin die geen docent van deze cursus is met 403', () => {
    const r = authorizeAvailabilityChange({ isAdmin: false, isCourseTeacher: false });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin of docent/i);
  });
});

describe('parseStudentVisible', () => {
  it('accepteert true', () => {
    expect(parseStudentVisible({ student_visible: true })).toEqual({ ok: true, value: true });
  });
  it('accepteert false', () => {
    expect(parseStudentVisible({ student_visible: false })).toEqual({ ok: true, value: false });
  });
  it('weigert ontbrekend veld met 400', () => {
    const r = parseStudentVisible({});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  it('weigert niet-boolean waarden (geen coercion) met 400', () => {
    for (const v of ['true', 1, 0, 'false', null, undefined]) {
      const r = parseStudentVisible({ student_visible: v });
      expect(r.ok).toBe(false);
      expect(r.status).toBe(400);
    }
  });
  it('weigert ontbrekende body met 400', () => {
    expect(parseStudentVisible(undefined).ok).toBe(false);
    expect(parseStudentVisible(null).ok).toBe(false);
  });
});

describe('memberCanAccessCourse', () => {
  it('laat iedereen toe als de cursus zichtbaar is', () => {
    expect(memberCanAccessCourse({ studentVisible: true, isCourseTeacher: false })).toBe(true);
    expect(memberCanAccessCourse({ studentVisible: true, isCourseTeacher: true })).toBe(true);
  });
  it('weert een student uit een verborgen cursus', () => {
    expect(memberCanAccessCourse({ studentVisible: false, isCourseTeacher: false })).toBe(false);
  });
  it('laat de docent van de cursus wél toe in een verborgen cursus', () => {
    expect(memberCanAccessCourse({ studentVisible: false, isCourseTeacher: true })).toBe(true);
  });
});

describe('canAccessCourseContent', () => {
  const base = { isAdmin: false, isCourseTeacher: false, isMember: false, isActive: true, studentVisible: true };

  it('laat admin/superuser altijd toe (ook verborgen + inactief)', () => {
    expect(canAccessCourseContent({ ...base, isAdmin: true, studentVisible: false, isActive: false })).toBe(true);
  });

  it('opent een actieve, zichtbare cursus voor élke student (géén membership nodig)', () => {
    expect(canAccessCourseContent({ ...base })).toBe(true);
  });

  it('weert een niet-lid uit een verborgen cursus', () => {
    expect(canAccessCourseContent({ ...base, studentVisible: false })).toBe(false);
  });

  it('laat de docent wél toe in een verborgen cursus (ook als zij geen lid-rij zou hebben)', () => {
    expect(canAccessCourseContent({ ...base, studentVisible: false, isCourseTeacher: true })).toBe(true);
  });

  it('weert een ingeschreven student uit een verborgen cursus (Task #270 blijft gelden)', () => {
    expect(canAccessCourseContent({ ...base, studentVisible: false, isMember: true })).toBe(false);
  });

  it('houdt een inactieve maar zichtbare cursus open voor leden en docenten', () => {
    expect(canAccessCourseContent({ ...base, isActive: false, isMember: true })).toBe(true);
    expect(canAccessCourseContent({ ...base, isActive: false, isCourseTeacher: true })).toBe(true);
  });

  it('weert een niet-lid uit een inactieve (gearchiveerde) cursus', () => {
    expect(canAccessCourseContent({ ...base, isActive: false })).toBe(false);
  });
});
