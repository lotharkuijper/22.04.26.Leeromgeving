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
