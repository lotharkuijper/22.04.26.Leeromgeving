import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      throw new Error("Unauthorized");
    }

    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (!profile || (profile.role !== "admin" && profile.role !== "superuser")) {
      throw new Error("Insufficient permissions");
    }

    const buckets = ["rag_sources", "docs_general", "datasets"];
    const results = [];

    for (const bucket of buckets) {
      const { data: files, error: listError } = await supabaseClient
        .storage
        .from(bucket)
        .list();

      if (listError) {
        results.push({ bucket, error: listError.message, deleted: 0 });
        continue;
      }

      if (!files || files.length === 0) {
        results.push({ bucket, deleted: 0 });
        continue;
      }

      const filePaths = files.map(file => file.name);

      const { error: deleteError } = await supabaseClient
        .storage
        .from(bucket)
        .remove(filePaths);

      if (deleteError) {
        results.push({ bucket, error: deleteError.message, deleted: 0 });
      } else {
        results.push({ bucket, deleted: filePaths.length });
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
