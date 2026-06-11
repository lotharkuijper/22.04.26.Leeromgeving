import { describe, it, expect } from 'vitest';
import {
  authorizeAvailabilityChange,
  parseStudentVisible,
  memberCanAccessCourse,
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
