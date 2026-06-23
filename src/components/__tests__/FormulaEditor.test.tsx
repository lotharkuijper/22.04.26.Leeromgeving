// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormulaEditor } from '../FormulaEditor';
import { LanguageProvider } from '../../i18n';

// Harness: een gecontroleerde textarea + FormulaEditor delen dezelfde state en
// ref, net als in de Studiecafé-composer. Zo zien we de werkelijke invoeging.
function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <LanguageProvider>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid="harness-textarea"
      />
      <FormulaEditor value={value} onChange={setValue} textareaRef={ref} />
    </LanguageProvider>
  );
}

function textarea() {
  return screen.getByTestId('harness-textarea') as HTMLTextAreaElement;
}

beforeEach(() => {
  try {
    localStorage.clear();
    localStorage.setItem('lair-vu-lang', 'nl');
  } catch { /* noop */ }
});

afterEach(() => cleanup());

describe('FormulaEditor — invoeging', () => {
  it('voegt een inline-formule in op een lege textarea', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // De √-knop voegt `\sqrt{}` binnen een inline-wrapper `$…$` in.
    await user.click(screen.getByRole('button', { name: '√' }));
    expect(textarea().value).toBe('$\\sqrt{}$');
  });

  it('voegt een formuleblok in met $$…$$ op eigen regels', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '$$' }));
    expect(textarea().value).toBe('$$\n\n$$');
  });

  it('voegt op de cursorpositie in, midden in bestaande tekst', async () => {
    const user = userEvent.setup();
    render(<Harness initial="ab" />);
    const el = textarea();
    el.focus();
    el.setSelectionRange(1, 1); // cursor tussen a en b
    await user.click(screen.getByRole('button', { name: '√' }));
    expect(el.value).toBe('a$\\sqrt{}$b');
  });

  it('nest een selectie binnen de ingevoegde wrapper', async () => {
    const user = userEvent.setup();
    render(<Harness initial="abc" />);
    const el = textarea();
    el.focus();
    el.setSelectionRange(0, 3); // selecteer "abc"
    await user.click(screen.getByRole('button', { name: '√' }));
    expect(el.value).toBe('$\\sqrt{abc}$');
  });
});

describe('FormulaEditor — voorbeeld (KaTeX)', () => {
  it('houdt de voorbeeldknop uitgeschakeld zonder wiskunde', () => {
    render(<Harness />);
    expect(screen.getByTestId('button-formula-preview-formula')).toBeDisabled();
  });

  it('rendert het ingevoegde fragment als KaTeX in het voorbeeld', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial="$x^2 + y^2 = z^2$" />);
    const previewBtn = screen.getByTestId('button-formula-preview-formula');
    expect(previewBtn).toBeEnabled();
    await user.click(previewBtn);
    const panel = await screen.findByTestId('formula-preview-formula');
    expect(panel).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
  });
});
