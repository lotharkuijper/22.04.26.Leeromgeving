import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const SUPERUSER_EMAIL = 'l.d.j.kuijper@vu.nl';

interface AuthHookPayload {
  type: 'SIGNUP' | 'LOGIN' | 'USER_UPDATED';
  user_id: string;
  email?: string;
}

interface ManualTriggerPayload {
  email?: string;
  trigger?: string;
  user_id?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const payload = await req.json();

    let userEmail: string | null = null;
    let userId: string | null = null;
    let triggerType = 'unknown';

    if (payload.type && payload.user_id) {
      const authPayload = payload as AuthHookPayload;
      userId = authPayload.user_id;
      userEmail = authPayload.email || null;
      triggerType = authPayload.type;

      console.log(`[AUTH HOOK] Triggered by ${triggerType} for user ${userId}`);

      if (!userEmail) {
        const { data: user } = await supabaseAdmin.auth.admin.getUserById(userId);
        userEmail = user?.user?.email || null;
      }
    } else {
      const manualPayload = payload as ManualTriggerPayload;
      userEmail = manualPayload.email || null;
      userId = manualPayload.user_id || null;
      triggerType = manualPayload.trigger || 'manual';

      console.log(`[MANUAL TRIGGER] Called with email: ${userEmail}, userId: ${userId}`);
    }

    if (!userEmail && !userId) {
      return new Response(
        JSON.stringify({ error: 'No email or user_id provided' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (!userId && userEmail) {
      const { data: users } = await supabaseAdmin.auth.admin.listUsers();
      const foundUser = users?.users?.find(u => u.email === userEmail);
      userId = foundUser?.id || null;
    }

    if (!userId) {
      console.log(`[AUTH HOOK] User not found for email: ${userEmail}`);
      return new Response(
        JSON.stringify({ error: 'User not found', email: userEmail }),
        {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const isSuperuser = userEmail === SUPERUSER_EMAIL;

    if (!isSuperuser) {
      console.log(`[AUTH HOOK] Not superuser: ${userEmail}`);
      return new Response(
        JSON.stringify({ success: true, message: 'Regular user, no action needed' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`[SUPERUSER ACTIVE] Processing ${userEmail} (${triggerType})`);

    const { data: existingProfile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (fetchError) {
      console.error('[SUPERUSER] Error fetching profile:', fetchError);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch profile', details: fetchError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (!existingProfile) {
      console.log('[SUPERUSER] Creating admin profile...');

      const { data: newProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: userId,
          email: userEmail,
          role: 'admin',
          full_name: 'Superuser Admin',
        })
        .select()
        .maybeSingle();

      if (insertError) {
        console.error('[SUPERUSER] Failed to create profile:', insertError);
        return new Response(
          JSON.stringify({ error: 'Failed to create profile', details: insertError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      console.log('[SUPERUSER ACTIVE] Admin profile created successfully');

      return new Response(
        JSON.stringify({
          success: true,
          message: '[SUPERUSER ACTIVE] Admin profile created',
          profile: newProfile,
          trigger: triggerType,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (existingProfile.role !== 'admin') {
      console.log(`[SUPERUSER] Fixing incorrect role: ${existingProfile.role} → admin`);

      const { data: updatedProfile, error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ role: 'admin' })
        .eq('id', userId)
        .select()
        .maybeSingle();

      if (updateError) {
        console.error('[SUPERUSER] Failed to update role:', updateError);
        return new Response(
          JSON.stringify({ error: 'Failed to update role', details: updateError.message }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      console.log('[SUPERUSER ACTIVE] Role corrected to admin');

      return new Response(
        JSON.stringify({
          success: true,
          message: '[SUPERUSER ACTIVE] Role corrected to admin',
          profile: updatedProfile,
          trigger: triggerType,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    console.log('[SUPERUSER ACTIVE] Admin status confirmed');

    return new Response(
      JSON.stringify({
        success: true,
        message: '[SUPERUSER ACTIVE] Admin status confirmed',
        profile: existingProfile,
        trigger: triggerType,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('[SUPERUSER] Error:', error);
    return new Response(
      JSON.stringify({
        error: 'Server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
