import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
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

    const initAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();

        if (!mounted) return;

        setSession(session);
        setUser(session?.user ?? null);

        if (session?.user) {
          await fetchProfile(session.user.id);
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

const {
  data: { subscription },
} = supabase.auth.onAuthStateChange((event, session) => {
  (async () => {
    if (!mounted) return;

    console.log(`[AUTH] State change: ${event}`);
    setSession(session);
    setUser(session?.user ?? null);

    if (session?.user) {
      await fetchProfile(session.user.id);
    } else {
      setProfile(null);
    }
  })();
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
        .select('id')
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

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    if (data.user) {
      await fetchProfile(data.user.id);
    }
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    clearAuthCache();

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
      },
    });

    if (error) {
      console.error('[AUTH] SignUp error:', error);
      throw new Error(error.message || 'Registratie mislukt');
    }

    if (!data.user) {
      throw new Error('Geen gebruiker aangemaakt');
    }

    console.log('[AUTH] User registered, profile created by trigger');

    if (data.user.id) {
      await fetchProfile(data.user.id);
    }
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
