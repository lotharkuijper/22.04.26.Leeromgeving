import { describe, it, expect } from 'vitest';
import {
  authorizeMemberRoleChange,
  checkLastTeacherProtection,
  parseForceFlag,
} from '../memberRoleAuth.js';

describe('authorizeMemberRoleChange', () => {
  it('staat admin altijd toe', () => {
    expect(authorizeMemberRoleChange({ isAdmin: true, isCourseTeacher: false })).toEqual({ allowed: true });
  });
  it('staat per-cursus docent van déze cursus toe', () => {
    expect(authorizeMemberRoleChange({ isAdmin: false, isCourseTeacher: true })).toEqual({ allowed: true });
  });
  it('weigert non-admin die geen docent van deze cursus is met 403', () => {
    const r = authorizeMemberRoleChange({ isAdmin: false, isCourseTeacher: false });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/admin of docent/i);
  });
});

describe('checkLastTeacherProtection', () => {
  it('laat student→teacher promotie altijd toe', () => {
    expect(checkLastTeacherProtection({
      existingMemberRole: 'student', newMemberRole: 'teacher',
      teacherCount: 1, isAdmin: false, force: false,
    })).toEqual({ ok: true });
  });
  it('laat teacher→student toe wanneer er nog meerdere docenten zijn', () => {
    expect(checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 3, isAdmin: false, force: false,
    })).toEqual({ ok: true });
  });
  it('weigert demotie van laatste docent met 409 last_teacher voor niet-admin', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: false, force: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('last_teacher');
  });
  it('weigert ook voor admin zonder force', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: true, force: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
  it('weigert non-admin zelfs met force=true', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: false, force: true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
  it('staat admin+force toe op laatste docent (cursus mag docentloos)', () => {
    expect(checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 1, isAdmin: true, force: true,
    })).toEqual({ ok: true });
  });
  it('behandelt teacherCount=0 als "laatste" en weigert zonder admin+force', () => {
    const r = checkLastTeacherProtection({
      existingMemberRole: 'teacher', newMemberRole: 'student',
      teacherCount: 0, isAdmin: false, force: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
});

describe('parseForceFlag', () => {
  it('herkent "1" en "true" (case-insensitive)', () => {
    expect(parseForceFlag('1')).toBe(true);
    expect(parseForceFlag('true')).toBe(true);
    expect(parseForceFlag('TRUE')).toBe(true);
  });
  it('weigert al het andere', () => {
    expect(parseForceFlag(undefined)).toBe(false);
    expect(parseForceFlag(null)).toBe(false);
    expect(parseForceFlag('')).toBe(false);
    expect(parseForceFlag('0')).toBe(false);
    expect(parseForceFlag('false')).toBe(false);
    expect(parseForceFlag('yes')).toBe(false);
  });
});
