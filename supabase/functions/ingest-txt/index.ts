import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { GoogleAuth } from "npm:google-auth-library";
import { VertexAI } from "npm:@google-cloud/vertexai";

const credentials = JSON.parse(Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")!);

const auth = new GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const vertex = new VertexAI({
  project: credentials.project_id,
  location: "us-central1",
  auth,
});

const model = vertex.getGenerativeModel({
  model: "gemini-1.5-pro",
});

serve(async (req) => {
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: "Hallo Gemini!" }] }],
  });

  return new Response(JSON.stringify(result), { status: 200 });
});
