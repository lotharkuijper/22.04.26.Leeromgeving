// Pure helper rond de chat-/completion-configuratie, losgekoppeld van
// server/index.js zodat hij in tests geïmporteerd kan worden zonder de hele
// Express-app te starten.
//
// Veiligheidsregel (Task #249): chat MOET altijd via de Azure OpenAI-resource
// van de VU lopen. Er is bewust GÉÉN fallback naar de publieke OpenAI-chat-API.
// Als Azure niet is geconfigureerd blijft de chat-URL leeg en falen chat-calls
// expliciet (de endpoints gaten bovendien op `azureChatReady`).

// Berekent de Azure-chatconfiguratie uit de opgegeven env-bag (default
// process.env). Geeft een leeg `chatUrl` en `azureChatReady=false` terug wanneer
// de Azure-endpoint of -sleutel ontbreekt; er wordt NOOIT teruggevallen op een
// publieke OpenAI-chat-URL.
export function computeChatConfig(env = process.env) {
  const endpoint = (env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  const apiKey = env.AZURE_OPENAI_API_KEY || '';
  const apiVersion = env.AZURE_OPENAI_API_VERSION || '2024-10-21';
  const deployment =
    env.AZURE_OPENAI_DEPLOYMENT || env.OPENAI_MODEL || 'gpt-5.5';
  const azureChatReady = Boolean(endpoint && apiKey);
  const chatUrl = azureChatReady
    ? `${endpoint}/openai/deployments/${encodeURIComponent(
        deployment,
      )}/chat/completions?api-version=${apiVersion}`
    : '';
  return { endpoint, apiKey, apiVersion, deployment, azureChatReady, chatUrl };
}
