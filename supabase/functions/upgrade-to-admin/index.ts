import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

interface UpgradeRequest {
  target_user_id?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Geen autorisatie header gevonden' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Niet ingelogd' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const { target_user_id }: UpgradeRequest = await req.json();
    const userId = target_user_id || user.id;

    const { data: currentProfile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      return new Response(
        JSON.stringify({ error: 'Kon profiel niet ophalen', details: profileError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const isCurrentUserAdmin = currentProfile?.role === 'admin';
    const isUpgradingSelf = userId === user.id;

    if (!isCurrentUserAdmin && target_user_id) {
      return new Response(
        JSON.stringify({ error: 'Alleen admins kunnen anderen upgraden' }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const { data: profileCount } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true });

    const isFirstUser = (profileCount as any)?.count === 0 || (profileCount as any)?.count === 1;

    if (!isUpgradingSelf && !isCurrentUserAdmin) {
      return new Response(
        JSON.stringify({ error: 'Geen toestemming' }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const { data: updatedProfile, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'admin' })
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (updateError) {
      return new Response(
        JSON.stringify({ error: 'Kon rol niet updaten', details: updateError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: isUpgradingSelf
          ? 'Je bent nu admin!'
          : 'Gebruiker is nu admin!',
        profile: updatedProfile,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Error in upgrade-to-admin:', error);
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
