// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';

// useAuth wordt gemockt zodat de tests geen echte Supabase-sessie nodig hebben;
// signIn/signUp zijn losse vi.fn()'s die we per test sturen.
const signInMock = vi.fn();
const signUpMock = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: signInMock, signUp: signUpMock }),
}));

// De LoginPage importeert de Supabase-client voor wachtwoord-vergeten; mock 'm
// zodat er geen env-vars/echte client nodig zijn.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: vi.fn().mockResolvedValue({ data: {}, error: null }),
    },
  },
}));

import { LoginPage } from '../LoginPage';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';

const nl = translations.nl as Record<string, string>;

function renderLogin() {
  return render(
    <LanguageProvider>
      <LoginPage />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.clear();
    // Forceer Nederlands zodat de tekst-asserties tegen de nl-vertalingen
    // kloppen; zonder voorkeur detecteert de provider de browsertaal (en in jsdom).
    localStorage.setItem('lair-vu-lang', 'nl');
  } catch {}
});

afterEach(() => {
  cleanup();
});

describe('LoginPage formulier-interactie', () => {
  it('toont het naam-veld pas na omschakelen naar registratie', async () => {
    const user = userEvent.setup();
    renderLogin();

    expect(screen.queryByTestId('input-fullname')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('button-toggle-signup'));

    expect(screen.getByTestId('input-fullname')).toBeInTheDocument();
  });

  it('toont de "naam verplicht"-melding bij een lege naam in registratie', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByTestId('button-toggle-signup'));
    // Spatie i.p.v. leeg: passeert de native `required`-check zodat het
    // formulier verstuurt en de JS-validatie (`.trim()`) zijn werk kan doen.
    await user.type(screen.getByTestId('input-fullname'), ' ');
    await user.type(screen.getByTestId('input-email'), 'nieuw@vu.nl');
    await user.type(screen.getByTestId('input-password'), 'geheim123');
    await user.click(screen.getByTestId('button-login'));

    expect(screen.getByTestId('text-login-error')).toHaveTextContent(
      nl['login.err.nameRequired'],
    );
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('toont de "wachtwoord te kort"-melding bij een te kort wachtwoord', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByTestId('button-toggle-signup'));
    await user.type(screen.getByTestId('input-fullname'), 'Nieuwe Gebruiker');
    await user.type(screen.getByTestId('input-email'), 'nieuw@vu.nl');
    await user.type(screen.getByTestId('input-password'), 'kort');
    await user.click(screen.getByTestId('button-login'));

    expect(screen.getByTestId('text-login-error')).toHaveTextContent(
      nl['login.err.passwordTooShort'],
    );
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('toont de succesbanner en keert terug naar inloggen na een geslaagde registratie', async () => {
    const user = userEvent.setup();
    signUpMock.mockResolvedValue(undefined);
    renderLogin();

    await user.click(screen.getByTestId('button-toggle-signup'));
    await user.type(screen.getByTestId('input-fullname'), 'Nieuwe Gebruiker');
    await user.type(screen.getByTestId('input-email'), 'nieuw@vu.nl');
    await user.type(screen.getByTestId('input-password'), 'geheim123');
    await user.click(screen.getByTestId('button-login'));

    await waitFor(() => {
      expect(screen.getByTestId('text-signup-success')).toHaveTextContent(
        nl['login.signUpSuccess'],
      );
    });
    expect(signUpMock).toHaveBeenCalledWith('nieuw@vu.nl', 'geheim123', 'Nieuwe Gebruiker');
    // Terug naar inlog-modus: het naam-veld is weg, knop toont "Inloggen".
    expect(screen.queryByTestId('input-fullname')).not.toBeInTheDocument();
    expect(screen.getByTestId('button-login')).toHaveTextContent(nl['login.loginBtn']);
  });

  it('wist een staande foutmelding bij het wisselen van modus', async () => {
    const user = userEvent.setup();
    renderLogin();

    // Forceer eerst een foutmelding in registratie (spatie-naam → trim faalt).
    await user.click(screen.getByTestId('button-toggle-signup'));
    await user.type(screen.getByTestId('input-fullname'), ' ');
    await user.type(screen.getByTestId('input-email'), 'nieuw@vu.nl');
    await user.type(screen.getByTestId('input-password'), 'geheim123');
    await user.click(screen.getByTestId('button-login'));
    expect(screen.getByTestId('text-login-error')).toBeInTheDocument();

    // Terug naar inloggen → de fout moet verdwenen zijn.
    await user.click(screen.getByTestId('button-toggle-signup'));
    expect(screen.queryByTestId('text-login-error')).not.toBeInTheDocument();
  });

  it('wist de succesbanner bij het opnieuw wisselen naar registratie', async () => {
    const user = userEvent.setup();
    signUpMock.mockResolvedValue(undefined);
    renderLogin();

    await user.click(screen.getByTestId('button-toggle-signup'));
    await user.type(screen.getByTestId('input-fullname'), 'Nieuwe Gebruiker');
    await user.type(screen.getByTestId('input-email'), 'nieuw@vu.nl');
    await user.type(screen.getByTestId('input-password'), 'geheim123');
    await user.click(screen.getByTestId('button-login'));

    await waitFor(() => {
      expect(screen.getByTestId('text-signup-success')).toBeInTheDocument();
    });

    // Weer naar registratie → de succesbanner moet weg zijn.
    await user.click(screen.getByTestId('button-toggle-signup'));
    expect(screen.queryByTestId('text-signup-success')).not.toBeInTheDocument();
  });

  it('rendert de wachtwoord-vergeten-modus en keert terug naar inloggen', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByTestId('button-forgot-password'));
    expect(screen.getByTestId('input-forgot-email')).toBeInTheDocument();
    expect(screen.getByTestId('button-send-reset')).toBeInTheDocument();

    await user.click(screen.getByTestId('button-cancel-forgot'));
    // Terug op het login-formulier.
    expect(screen.queryByTestId('input-forgot-email')).not.toBeInTheDocument();
    expect(screen.getByTestId('input-email')).toBeInTheDocument();
  });

  it('logt in met de ingevulde gegevens in inlog-modus', async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValue(undefined);
    renderLogin();

    await user.type(screen.getByTestId('input-email'), 'je@vu.nl');
    await user.type(screen.getByTestId('input-password'), 'geheim123');
    await user.click(screen.getByTestId('button-login'));

    await waitFor(() => {
      expect(signInMock).toHaveBeenCalledWith('je@vu.nl', 'geheim123');
    });
  });
});
