// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LearningLevelSelector } from '../LearningLevelSelector';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';

const nl = translations.nl as Record<string, string>;

beforeEach(() => {
  try {
    localStorage.clear();
    localStorage.setItem('lair-vu-lang', 'nl');
  } catch {}
});

afterEach(() => cleanup());

function renderSelector(props: Partial<React.ComponentProps<typeof LearningLevelSelector>> = {}) {
  const onChange = props.onChange ?? vi.fn();
  const utils = render(
    <LanguageProvider>
      <LearningLevelSelector value={props.value ?? 2} onChange={onChange} {...props} />
    </LanguageProvider>,
  );
  return { ...utils, onChange };
}

describe('LearningLevelSelector', () => {
  it('toont 5 niveauknoppen met de juiste labels', () => {
    renderSelector();
    for (let lvl = 1; lvl <= 5; lvl++) {
      const btn = screen.getByTestId(`button-learning-level-${lvl}`);
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent(nl[`learningLevel.level${lvl}.label`]);
    }
  });

  it('markeert het actieve niveau via aria-pressed', () => {
    renderSelector({ value: 3 });
    expect(screen.getByTestId('button-learning-level-3')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('button-learning-level-2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('roept onChange aan met het gekozen niveau bij klik', async () => {
    const user = userEvent.setup();
    const { onChange } = renderSelector({ value: 2 });
    await user.click(screen.getByTestId('button-learning-level-4'));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('roept onChange niet aan wanneer disabled', async () => {
    const user = userEvent.setup();
    const { onChange } = renderSelector({ value: 2, disabled: true });
    await user.click(screen.getByTestId('button-learning-level-5'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('toont de helptekst in de standaardvariant', () => {
    renderSelector();
    expect(screen.getByText(nl['learningLevel.help'])).toBeInTheDocument();
  });

  it('verbergt de helptekst in de compacte variant', () => {
    renderSelector({ compact: true });
    expect(screen.queryByText(nl['learningLevel.help'])).not.toBeInTheDocument();
    // De 5 niveauknoppen blijven wel zichtbaar.
    expect(screen.getByTestId('button-learning-level-1')).toBeInTheDocument();
  });
});
