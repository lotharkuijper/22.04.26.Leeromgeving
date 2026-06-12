import { describe, it, expect } from 'vitest';
import { computeChatConfig } from '../chatConfig.js';

// ───────────────────────────────────────────────────────────────────────────
// Veiligheidsregressietest (Task #249): chat moet ALTIJD via de Azure
// OpenAI-resource van de VU lopen. Er mag nooit (opnieuw) een stille fallback
// naar de publieke OpenAI-chat-API worden geïntroduceerd. Deze unit-tests
// bewaken de pure config-helper; chatConfig.endpoints.test.js bewaakt de
// daadwerkelijke HTTP-endpoints.
// ───────────────────────────────────────────────────────────────────────────

describe('computeChatConfig — geen publieke OpenAI-chat-fallback', () => {
  it('levert een lege chat-URL en azureChatReady=false als Azure-env ontbreekt', () => {
    const cfg = computeChatConfig({});
    expect(cfg.azureChatReady).toBe(false);
    expect(cfg.chatUrl).toBe('');
  });

  it('valt NIET terug op api.openai.com als alleen de publieke key aanwezig is', () => {
    const cfg = computeChatConfig({
      OPENAI_API_KEY: 'sk-public-key',
      OPENAI_MODEL: 'gpt-4o-mini',
    });
    expect(cfg.azureChatReady).toBe(false);
    expect(cfg.chatUrl).toBe('');
    expect(cfg.chatUrl).not.toContain('api.openai.com');
  });

  it('blijft leeg als alleen de endpoint of alleen de sleutel is gezet', () => {
    expect(
      computeChatConfig({ AZURE_OPENAI_ENDPOINT: 'https://leap-openai-vu.openai.azure.com' })
        .chatUrl,
    ).toBe('');
    expect(
      computeChatConfig({ AZURE_OPENAI_API_KEY: 'azure-key' }).chatUrl,
    ).toBe('');
  });

  it('bouwt een Azure-deployment-URL (geen publieke OpenAI-URL) als beide aanwezig zijn', () => {
    const cfg = computeChatConfig({
      AZURE_OPENAI_ENDPOINT: 'https://leap-openai-vu.openai.azure.com/',
      AZURE_OPENAI_API_KEY: 'azure-key',
      AZURE_OPENAI_DEPLOYMENT: 'gpt-5.5',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
    });
    expect(cfg.azureChatReady).toBe(true);
    expect(cfg.chatUrl).toBe(
      'https://leap-openai-vu.openai.azure.com/openai/deployments/gpt-5.5/chat/completions?api-version=2024-10-21',
    );
    expect(cfg.chatUrl).not.toContain('api.openai.com');
    expect(cfg.chatUrl).toContain('/openai/deployments/');
  });

  it('routeert via de deployment in de URL, niet via een body-model', () => {
    const cfg = computeChatConfig({
      AZURE_OPENAI_ENDPOINT: 'https://leap-openai-vu.openai.azure.com',
      AZURE_OPENAI_API_KEY: 'azure-key',
      AZURE_OPENAI_DEPLOYMENT: 'my deployment/x',
    });
    // De deployment wordt URL-geëncodeerd in het pad opgenomen.
    expect(cfg.chatUrl).toContain('/openai/deployments/my%20deployment%2Fx/');
  });
});
