import { describe, it, expect } from 'vitest';
import { LLMError, llmErrorToDutch } from '../llm.service';

// ───────────────────────────────────────────────────────────────────────────
// Frontend-test (Task #231): de /api/chat-handler faalt bij een blijvend
// lege/afgekapte reasoning-respons met HTTP 502 en code "empty_response" (of
// "length"). De UI moet dan de tokenruimte-melding tonen — NIET de generieke
// "serverfout" (≥500) of "weigerde de toegang" (401/403). De volgorde van de
// checks in llmErrorToDutch is dus cruciaal: empty_response/length moeten vóór
// de status≥500-tak afgevangen worden.
// ───────────────────────────────────────────────────────────────────────────

describe('llmErrorToDutch — empty_response / length', () => {
  it('toont de tokenruimte-melding voor code "empty_response" (NL)', () => {
    const err = new LLMError('Het taalmodel gaf een lege reactie terug.', 502, 'empty_response');
    const { title, detail } = llmErrorToDutch(err, 'nl');

    expect(title).toBe('Het antwoord paste niet in de beschikbare tokenruimte.');
    expect(title).not.toMatch(/serverfout/i);
    expect(title).not.toMatch(/weigerde de toegang/i);
    expect(detail).toMatch(/tokenruimte|match_count|RAG-drempel/i);
  });

  it('toont de tokenruimte-melding voor code "length" (NL)', () => {
    const err = new LLMError('Het antwoord werd afgekapt.', 502, 'length');
    const { title } = llmErrorToDutch(err, 'nl');

    expect(title).toBe('Het antwoord paste niet in de beschikbare tokenruimte.');
    expect(title).not.toMatch(/serverfout/i);
  });

  it('toont de Engelse tokenruimte-melding voor code "empty_response" (EN)', () => {
    const err = new LLMError('Empty completion.', 502, 'empty_response');
    const { title, detail } = llmErrorToDutch(err, 'en');

    expect(title).toBe('The answer did not fit in the available token space.');
    expect(title).not.toMatch(/server error/i);
    expect(detail).toMatch(/token space|match_count|RAG threshold/i);
  });

  it('valt terug op de tokenruimte-melding via de ruwe boodschap (geen code)', () => {
    const err = new LLMError('Het taalmodel gaf een lege reactie terug: er was te weinig tokenruimte.', 502);
    const { title } = llmErrorToDutch(err, 'nl');

    expect(title).toBe('Het antwoord paste niet in de beschikbare tokenruimte.');
  });

  it('blijft een gewone 502 zonder lege-respons-signaal als serverfout tonen', () => {
    const err = new LLMError('Bad gateway upstream', 502, 'bad_gateway');
    const { title } = llmErrorToDutch(err, 'nl');

    expect(title).toBe('Het taalmodel reageert niet (serverfout).');
  });
});
