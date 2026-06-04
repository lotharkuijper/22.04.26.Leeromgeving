import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { isDefinitiveAuthError } from '../lib/authSession';
import type { Database } from '../lib/database.types';

type Profile = Database['public']['Tables']['profiles']['Row'];

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  isAdmin: boolean;
  isDocent: boolean;
  isStudent: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SUPERUSER_EMAIL = 'l.d.j.kuijper@vu.nl';

// Vangnet: voorkom dat een hangende Supabase-aanroep (netwerk/lock) de UI
// eindeloos in 'laden' laat staan. Na `ms` ms wordt de race afgewezen.
function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[AUTH] ${label} duurde te lang (>${ms}ms)`)), ms),
    ),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // True zodra de user in minstens één cursus member_role='teacher' heeft.
  // Wordt geherlaadd via fetchTeacherFlag bij login/profile-refresh.
  const [isTeacherAnywhere, setIsTeacherAnywhere] = useState(false);

  useEffect(() => {
    let mounted = true;

    // Profiel ophalen mag NOOIT de auth-flow blokkeren of laten hangen.
    // We draaien het los van navigatie, met een time-out-vangnet.
    const loadProfileSafe = (userId: string) => {
      withTimeout(fetchProfile(userId), 12000, 'fetchProfile').catch((err) => {
        console.error('[AUTH] Profiel laden mislukt/time-out:', err);
        if (mounted) setProfile(null);
      });
    };

    const initAuth = async () => {
      try {
        const { data: { session } } = await withTimeout(
          supabase.auth.getSession(),
          10000,
          'getSession',
        );

        if (!mounted) return;

        // Een uit localStorage geladen sessie kan een DODE refresh-token hebben
        // (bv. na een Supabase API-key-/JWT-rotatie). getSession() geeft die
        // sessie dan toch terug, maar de access-token is verlopen en kan niet
        // ververst worden — waardoor ELKE server-call 401 geeft terwijl de UI
        // denkt dat je bent ingelogd. We valideren de sessie daarom expliciet
        // tegen Supabase. Bij een definitieve auth-fout loggen we schoon uit
        // zodat je opnieuw kunt inloggen i.p.v. vast te zitten in een kapotte
        // sessie. Bij netwerk-/time-outfouten laten we de sessie staan (geen
        // onterechte uitlog bij een haperende verbinding).
        if (session?.user) {
          const { error: validateError } = await withTimeout(
            supabase.auth.getUser(),
            10000,
            'validateSession',
          ).catch((e: unknown) => ({ error: e }));

          if (isDefinitiveAuthError(validateError)) {
            console.warn(
              '[AUTH] Opgeslagen sessie is ongeldig — schoon uitloggen zodat je opnieuw kunt inloggen.',
              (validateError as { message?: string } | null)?.message,
            );
            await supabase.auth.signOut().catch(() => {});
            if (mounted) {
              setSession(null);
              setUser(null);
              setProfile(null);
            }
            return;
          }
        }

        setSession(session);
        setUser(session?.user ?? null);

        // Niet awaiten: de UI mag direct door, profiel komt op de achtergrond.
        if (session?.user) {
          loadProfileSafe(session.user.id);
        }
      } catch (error) {
        console.error('[AUTH] Initialization error:', error);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    initAuth();

    // Belangrijk: binnen deze callback GEEN Supabase-aanroepen await'en —
    // dat is het bekende Supabase-deadlockpatroon (de callback houdt een lock
    // vast). We zetten alleen state en defereren de profiel-ophaling.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

      console.log(`[AUTH] State change: ${event}`);
      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        const uid = session.user.id;
        setTimeout(() => {
          if (mounted) loadProfileSafe(uid);
        }, 0);
      } else {
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);


  const clearAuthCache = () => {
    try {
      sessionStorage.clear();
      console.log('[AUTH] Session cache cleared');
    } catch (error) {
      console.error('[AUTH] Failed to clear cache:', error);
    }
  };

  const enforceSuperuserRole = async (userId: string, userEmail: string) => {
    if (userEmail !== SUPERUSER_EMAIL) return;

    console.log('[SUPERUSER] Enforcing admin role via Edge Function...');

    try {
      const { data, error } = await supabase.functions.invoke('auth-enforce-superuser', {
        body: { email: userEmail, user_id: userId, trigger: 'manual_login' }
      });

      if (error) {
        console.error('[SUPERUSER] Edge function call failed:', error);
      } else {
        console.log('[SUPERUSER ACTIVE] Edge function response:', data);
      }
    } catch (error) {
      console.error('[SUPERUSER] Edge function error:', error);
    }

    try {
      const { data: rpcResult, error: rpcError } = await supabase.rpc('force_superuser_status', {
        target_email: userEmail
      });

      if (rpcError) {
        console.error('[SUPERUSER] RPC failsafe failed:', rpcError);
      } else {
        console.log('[SUPERUSER ACTIVE] RPC failsafe response:', rpcResult);
      }
    } catch (error) {
      console.error('[SUPERUSER] RPC failsafe error:', error);
    }
  };

  const fetchTeacherFlag = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('course_members')
        .select('user_id')
        .eq('user_id', userId)
        .eq('member_role', 'teacher')
        .limit(1);
      if (error) {
        console.warn('[AUTH] teacher-flag fetch failed:', error.message);
        setIsTeacherAnywhere(false);
        return;
      }
      setIsTeacherAnywhere((data?.length || 0) > 0);
    } catch (err) {
      console.warn('[AUTH] teacher-flag exception:', err);
      setIsTeacherAnywhere(false);
    }
  };

  const fetchProfile = async (userId: string) => {
    console.log('[AUTH] Fetching profile for user:', userId);

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        console.error('[AUTH] Profile fetch error:', error);
        setProfile(null);
        return;
      }

      if (!data) {
        console.warn('[AUTH] No profile found, creating one...');

        const { data: { user } } = await supabase.auth.getUser();
        const userEmail = user?.email;
        const fullName = user?.user_metadata?.full_name;

        if (!userEmail) {
          console.error('[AUTH] Cannot create profile: no email found');
          setProfile(null);
          return;
        }

        const roleToAssign = userEmail === SUPERUSER_EMAIL ? 'admin' : 'student';

        const { data: newProfile, error: insertError } = await supabase
          .from('profiles')
          .insert({
            id: userId,
            email: userEmail,
            role: roleToAssign,
            full_name: fullName || 'User',
          })
          .select()
          .single();

        if (insertError) {
          console.error('[AUTH] Failed to create profile:', insertError);
          setProfile(null);
          return;
        }

        console.log('[AUTH] Profile created successfully:', newProfile.email, newProfile.role);
        setProfile(newProfile);
        await fetchTeacherFlag(userId);
        return;
      }

      console.log('[AUTH] Profile loaded:', data.email, data.role);

      if (data.email === SUPERUSER_EMAIL && data.role === 'admin') {
        console.log('[SUPERUSER ACTIVE] Admin access confirmed');
      }

      setProfile(data);
      await fetchTeacherFlag(userId);

    } catch (error) {
      console.error('[AUTH] Unexpected error fetching profile:', error);
      setProfile(null);
    }
  };

  const signIn = async (email: string, password: string) => {
    clearAuthCache();

    // Vangnet-time-out zodat de inlogknop nooit eindeloos blijft 'laden'.
    const { error } = await withTimeout(
      supabase.auth.signInWithPassword({ email, password }),
      15000,
      'signIn',
    );

    if (error) throw error;

    // Geen await op fetchProfile: navigatie wordt door de `user`-state gedreven
    // (App-router stuurt door zodra `user` is gezet). Het profiel laadt op de
    // achtergrond via de onAuthStateChange-listener. Zo kan een trage of
    // mislukte profiel-ophaling de login nooit laten vastlopen.
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    clearAuthCache();

    const { data, error } = await withTimeout(
      supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
          },
        },
      }),
      15000,
      'signUp',
    );

    if (error) {
      console.error('[AUTH] SignUp error:', error);
      throw new Error(error.message || 'Registratie mislukt');
    }

    // Supabase verbergt bestaande accounts: bij een al geregistreerd e-mailadres
    // (met e-mailbevestiging aan) komt er GEEN error terug, maar een 'lege' user
    // zonder identities en zonder sessie. Detecteer dat en geef een duidelijke
    // melding i.p.v. een stille 'success'. ('User already registered' wordt in
    // LoginPage gemapt naar de nette melding "Account bestaat al".)
    const identities = data.user?.identities;
    if (data.user && Array.isArray(identities) && identities.length === 0) {
      throw new Error('User already registered');
    }

    if (!data.user) {
      throw new Error('Geen gebruiker aangemaakt');
    }

    console.log('[AUTH] User registered, profile created by trigger');

    // Geen await op fetchProfile: idem aan signIn — listener handelt profiel +
    // navigatie af zonder deadlock-risico.
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const refreshProfile = async () => {
    if (user?.id) {
      console.log('Manually refreshing profile...');
      await fetchProfile(user.id);
    }
  };

  // SUPERUSER OVERRIDE — hardcoded admin
  const email = user?.email;
  const superuser = email === SUPERUSER_EMAIL;
  const isAdmin = superuser || profile?.role === 'admin';
  // 'isDocent' = docent in minstens één cursus (per-course rol via
  // course_members.member_role='teacher'). De globale profiles.role='docent'
  // bestaat niet meer als entry-criterium; admins zijn altijd ook staff.
  const isDocent = !isAdmin && isTeacherAnywhere;
  // Een gebruiker is 'student' wanneer hij/zij geen admin én geen docent is.
  // Een per-cursus docent kan in een andere cursus gewoon student zijn — de
  // student-rol verwijst hier naar de globale UI-fallback, niet per cursus.
  const isStudent = !isAdmin && !isTeacherAnywhere;


  const value = {
    user,
    profile,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    refreshProfile,
    isAdmin,
    isDocent,
    isStudent,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
