import { describe, it, expect } from 'vitest';
import {
  normalizeLatexDelimiters,
  balanceMathDelimiters,
  prepareLatex,
} from '../mathDelimiters';

describe('normalizeLatexDelimiters', () => {
  it('zet \\(...\\) om naar $...$', () => {
    expect(normalizeLatexDelimiters('De kans \\(P(A)\\) is hoog.')).toBe(
      'De kans $P(A)$ is hoog.'
    );
  });

  it('zet \\[...\\] om naar $$...$$', () => {
    expect(normalizeLatexDelimiters('\\[ a = b \\]')).toBe('$$ a = b $$');
  });

  it('laat inhoud binnen fenced code ongemoeid', () => {
    const input = '```\n\\(x\\)\n```';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });

  it('laat inhoud binnen inline code ongemoeid', () => {
    const input = 'gebruik `\\(x\\)` letterlijk';
    expect(normalizeLatexDelimiters(input)).toBe(input);
  });
});

describe('balanceMathDelimiters', () => {
  it('laat correct gepaarde inline-formules ongemoeid', () => {
    const input = 'Als $X$ en $Y$ onafhankelijk zijn.';
    expect(balanceMathDelimiters(input)).toBe(input);
  });

  it('laat correct gepaarde display-formules ongemoeid', () => {
    const input = 'Dan geldt $$Pr(Y \\mid X) = Pr(Y)$$ einde.';
    expect(balanceMathDelimiters(input)).toBe(input);
  });

  it('escapet een los (ongepaard) display-teken', () => {
    const input = 'Pr(X)=Pr(Y). $$ daarna gewone tekst.';
    expect(balanceMathDelimiters(input)).toBe(
      'Pr(X)=Pr(Y). \\$\\$ daarna gewone tekst.'
    );
  });

  it('escapet een los enkel dollarteken', () => {
    const input = 'Het kost $5 euro.';
    expect(balanceMathDelimiters(input)).toBe('Het kost \\$5 euro.');
  });

  it('voorkomt het domino-effect: eerste formule blijft, los $$ wordt literal, inline-formules blijven', () => {
    const input =
      'dan geldt $$Pr(Y \\mid X) = Pr(Y)$$ en dan wordt: ' +
      'Pr(X) $$ [2] verandert kennis van $X$ iets aan $Y$?';
    const out = balanceMathDelimiters(input);
    // eerste display blijft intact
    expect(out).toContain('$$Pr(Y \\mid X) = Pr(Y)$$');
    // het losse $$ is geescaped
    expect(out).toContain('Pr(X) \\$\\$ [2]');
    // de inline-formules blijven gepaard staan
    expect(out).toContain('$X$');
    expect(out).toContain('$Y$');
  });

  it('escapet een enkel dollarteken dat een geldige afsluiter pas na een lege regel zou hebben', () => {
    const input = 'prijs is $5\n\nen iets anders $ hier';
    const out = balanceMathDelimiters(input);
    expect(out).toBe('prijs is \\$5\n\nen iets anders \\$ hier');
  });

  it('laat ge-escapete dollartekens met rust', () => {
    const input = 'literal \\$ teken alleen';
    expect(balanceMathDelimiters(input)).toBe(input);
  });

  it('raakt dollartekens binnen code niet aan', () => {
    const input = 'code: `const a = $$ x` en tekst';
    expect(balanceMathDelimiters(input)).toBe(input);
  });

  it('laat tekst zonder dollartekens ongemoeid', () => {
    const input = 'gewone tekst zonder formules';
    expect(balanceMathDelimiters(input)).toBe(input);
  });
});

describe('prepareLatex', () => {
  it('normaliseert en balanceert in één stap', () => {
    const input = 'inline \\(a\\) en een los $ teken';
    expect(prepareLatex(input)).toBe('inline $a$ en een los \\$ teken');
  });

  it('is veilig bij lege invoer', () => {
    expect(prepareLatex('')).toBe('');
  });
});
