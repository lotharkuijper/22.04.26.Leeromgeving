import { describe, it, expect } from 'vitest';
import { isUnsupportedSamplingParamError } from '../openaiSampling.js';

describe('isUnsupportedSamplingParamError', () => {
  it('returns false for empty/ok responses', () => {
    expect(isUnsupportedSamplingParamError(undefined)).toBe(false);
    expect(isUnsupportedSamplingParamError(null)).toBe(false);
    expect(isUnsupportedSamplingParamError({})).toBe(false);
    expect(isUnsupportedSamplingParamError({ choices: [] })).toBe(false);
  });

  it('detects rejection via error.param', () => {
    expect(isUnsupportedSamplingParamError({ error: { param: 'temperature' } })).toBe(true);
    expect(isUnsupportedSamplingParamError({ error: { param: 'top_p' } })).toBe(true);
    expect(isUnsupportedSamplingParamError({ error: { param: 'TOP_P' } })).toBe(true);
  });

  it('detects rejection via error.message', () => {
    expect(
      isUnsupportedSamplingParamError({
        error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported." },
      }),
    ).toBe(true);
    expect(
      isUnsupportedSamplingParamError({
        error: { message: 'top_p is not supported with this model.' },
      }),
    ).toBe(true);
  });

  it('does not match unrelated 400 errors', () => {
    expect(
      isUnsupportedSamplingParamError({
        error: { code: 'context_length_exceeded', message: 'maximum context length is 128000 tokens' },
      }),
    ).toBe(false);
    expect(
      isUnsupportedSamplingParamError({
        error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
      }),
    ).toBe(false);
    // mentions temperature but not as an unsupported-param error
    expect(
      isUnsupportedSamplingParamError({
        error: { message: 'The temperature outside is nice today' },
      }),
    ).toBe(false);
  });
});
