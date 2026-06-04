// Classificeert of een fout bij sessie-validatie (supabase.auth.getUser)
// betekent dat de OPGESLAGEN sessie definitief ongeldig is en de gebruiker
// schoon uitgelogd moet worden, óf dat het een tijdelijke fout is (netwerk,
// time-out, rate-limit, serverfout) waarbij we de sessie juist moeten LATEN
// staan om onterechte uitlog te voorkomen.
//
// Achtergrond: een uit localStorage geladen sessie kan een dode refresh-token
// hebben (bv. na een Supabase API-key-/JWT-rotatie). getUser() geeft dan een
// auth-fout met status 401/403 of een AuthSessionMissingError terug. Een
// generieke AuthApiError met status 429/5xx is daarentegen tijdelijk en mag
// NOOIT tot uitloggen leiden.

export interface AuthLikeError {
  status?: number;
  name?: string;
  message?: string;
}

export function isDefinitiveAuthError(err: unknown): boolean {
  if (!err) return false;
  const e = err as AuthLikeError;
  const status = typeof e.status === 'number' ? e.status : undefined;

  // Definitief: de server wijst de sessie expliciet af.
  if (status === 401 || status === 403) return true;

  // Geen sessie aanwezig volgens Supabase.
  if (e.name === 'AuthSessionMissingError') return true;

  // Tijdelijke fouten (rate-limit, serverfout, netwerk/time-out, of een
  // AuthApiError zonder duidelijke 401/403): sessie laten staan.
  return false;
}
