// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MarkdownMessage } from '../MarkdownMessage';

afterEach(() => cleanup());

// Borgt het kerngedrag voor de vertaalde-bron-weergave: wiskundige formules
// moeten als KaTeX renderen (niet als platte $-tekens), en de fontScale van de
// documentviewer moet via de style-prop op de prose-root doorwerken.
describe('MarkdownMessage wiskunde-rendering', () => {
  it('rendert inline LaTeX ($...$) als KaTeX', () => {
    const { container } = render(
      <MarkdownMessage content={'De formule is $x^2 + y^2 = z^2$ klaar.'} />,
    );
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('rendert display LaTeX ($$...$$) als KaTeX', () => {
    const { container } = render(<MarkdownMessage content={'$$\\frac{a}{b}$$'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('zet ongebalanceerde dollartekens niet om in een (rode) formule', () => {
    const { container } = render(
      <MarkdownMessage content={'Prijs is $5 voor het eerste item.'} />,
    );
    // Eén los $-teken mag geen KaTeX-render forceren.
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('geeft de style-prop (fontScale) door aan de prose-root', () => {
    const { getByTestId } = render(
      <MarkdownMessage content={'x'} style={{ fontSize: '1.5rem' }} />,
    );
    expect((getByTestId('markdown-message') as HTMLElement).style.fontSize).toBe('1.5rem');
  });
});

// Borgt het regel-per-regel-gedrag van de vertaalde-bron-weergave (Task #285):
// met `hardBreaks` worden enkele regeleindes harde breaks (<br>), zodat dichte
// dia's/pagina's hun regelindeling behouden. Zonder de prop (chat-default) valt
// een enkel regeleinde gewoon samen in één paragraaf, zoals Markdown standaard.
describe('MarkdownMessage hardBreaks (vertaalpaneel)', () => {
  it('zet enkele regeleindes om in harde breaks wanneer hardBreaks aan staat', () => {
    const { container } = render(
      <MarkdownMessage content={'Regel 1\nRegel 2\nRegel 3'} hardBreaks />,
    );
    const brs = container.querySelectorAll('p br');
    expect(brs.length).toBe(2);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(1);
    expect(paragraphs[0].textContent).toContain('Regel 1');
    expect(paragraphs[0].textContent).toContain('Regel 2');
    expect(paragraphs[0].textContent).toContain('Regel 3');
  });

  it('laat enkele regeleindes samenvloeien zonder hardBreaks (chat-default)', () => {
    const { container } = render(
      <MarkdownMessage content={'Regel 1\nRegel 2\nRegel 3'} />,
    );
    expect(container.querySelectorAll('p br').length).toBe(0);
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(1);
  });

  it('rendert wiskunde ($...$ en $$...$$) correct met hardBreaks', () => {
    const { container } = render(
      <MarkdownMessage
        content={'Inline $x^2 + y^2 = z^2$ tekst\nEn los: $$\\frac{a}{b}$$'}
        hardBreaks
      />,
    );
    // Eén inline- en één display-formule → twee KaTeX-renders, geen losse $-tekens.
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
  });

  it('rendert lijsten correct met hardBreaks', () => {
    const { container } = render(
      <MarkdownMessage content={'- Item een\n- Item twee\n- Item drie'} hardBreaks />,
    );
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain('Item een');
    expect(items[2].textContent).toContain('Item drie');
  });

  it('rendert tabellen correct met hardBreaks', () => {
    const { container } = render(
      <MarkdownMessage
        content={'| Kop A | Kop B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |'}
        hardBreaks
      />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
  });
});
