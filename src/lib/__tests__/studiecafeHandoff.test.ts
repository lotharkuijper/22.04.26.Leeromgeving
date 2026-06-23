// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashStudiecafeHandoff,
  takeStudiecafeHandoff,
  type StudiecafeHandoff,
} from '../studiecafeHandoff';
import { type ChatExcerptAttachment } from '../../components/ChatExcerptCard';

const KEY = 'leapvu:studiecafe-handoff';

function makeAttachment(): ChatExcerptAttachment {
  return {
    type: 'chat_excerpt',
    content: 'Dit is het AI-antwoord met $x^2$.',
    sources: [{ index: 1, title: 'Hoofdstuk 1', documentId: 'doc-1' }],
    meta: { module: 'chat', courseId: 'course-1' },
  };
}

function makeHandoff(): StudiecafeHandoff {
  return {
    v: 1,
    courseId: 'course-1',
    category: 'check-llm',
    attachment: makeAttachment(),
  };
}

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* noop */ }
});

describe('studiecafeHandoff — stash/take round-trip', () => {
  it('geeft een gestalde overdracht ongewijzigd terug', () => {
    const h = makeHandoff();
    stashStudiecafeHandoff(h);
    const got = takeStudiecafeHandoff();
    expect(got).toEqual(h);
  });

  it('leest de overdracht slechts één keer (eenmalig wissen)', () => {
    stashStudiecafeHandoff(makeHandoff());
    expect(takeStudiecafeHandoff()).not.toBeNull();
    // De tweede keer is er niets meer — de sleutel is verwijderd.
    expect(takeStudiecafeHandoff()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('geeft null wanneer er niets is gestald', () => {
    expect(takeStudiecafeHandoff()).toBeNull();
  });
});

describe('studiecafeHandoff — ongeldige payloads worden geweigerd', () => {
  it('weigert kapotte JSON', () => {
    sessionStorage.setItem(KEY, '{ niet: geldige json');
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('weigert een verkeerde versie', () => {
    const h = { ...makeHandoff(), v: 2 };
    sessionStorage.setItem(KEY, JSON.stringify(h));
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('weigert een ontbrekende bijlage', () => {
    const h: any = makeHandoff();
    delete h.attachment;
    sessionStorage.setItem(KEY, JSON.stringify(h));
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('weigert een bijlage met een verkeerd type', () => {
    const h: any = makeHandoff();
    h.attachment.type = 'iets_anders';
    sessionStorage.setItem(KEY, JSON.stringify(h));
    expect(takeStudiecafeHandoff()).toBeNull();
  });

  it('wist ook een ongeldige payload (eenmalig)', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ v: 99 }));
    expect(takeStudiecafeHandoff()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
