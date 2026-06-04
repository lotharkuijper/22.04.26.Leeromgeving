import { describe, it, expect } from 'vitest';
import { isDefinitiveAuthError } from '../authSession';

describe('isDefinitiveAuthError', () => {
  it('logt uit bij een verlopen/ongeldige sessie (401)', () => {
    expect(isDefinitiveAuthError({ name: 'AuthApiError', status: 401, message: 'invalid JWT' })).toBe(true);
  });

  it('logt uit bij een verboden sessie (403 bad_jwt)', () => {
    expect(isDefinitiveAuthError({ name: 'AuthApiError', status: 403, message: 'bad_jwt' })).toBe(true);
  });

  it('logt uit wanneer er geen sessie meer is (AuthSessionMissingError)', () => {
    expect(isDefinitiveAuthError({ name: 'AuthSessionMissingError', message: 'Auth session missing!' })).toBe(true);
  });

  it('laat de sessie staan bij een rate-limit (429)', () => {
    expect(isDefinitiveAuthError({ name: 'AuthApiError', status: 429, message: 'rate limited' })).toBe(false);
  });

  it('laat de sessie staan bij een serverfout (500)', () => {
    expect(isDefinitiveAuthError({ name: 'AuthApiError', status: 500, message: 'internal' })).toBe(false);
  });

  it('laat de sessie staan bij een netwerk-/time-outfout (geen status)', () => {
    expect(isDefinitiveAuthError(new Error('[AUTH] validateSession duurde te lang (>10000ms)'))).toBe(false);
  });

  it('laat de sessie staan bij een generieke AuthApiError zonder 401/403', () => {
    expect(isDefinitiveAuthError({ name: 'AuthApiError', message: 'something' })).toBe(false);
  });

  it('geeft false terug bij null/undefined (geen fout = sessie geldig)', () => {
    expect(isDefinitiveAuthError(null)).toBe(false);
    expect(isDefinitiveAuthError(undefined)).toBe(false);
  });
});
