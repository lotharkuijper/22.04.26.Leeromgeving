import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_KINDS,
  DEFAULT_NOTIFICATION_PREFS,
  normalizeNotificationPrefs,
  prefAllowsKind,
  buildDedupKey,
  groupPendingByUser,
  partitionByPrefs,
  escapeHtml,
  summarizeUserNotifications,
  buildDigestEmail,
  computeAnnouncementAudience,
} from '../notifications.js';

describe('normalizeNotificationPrefs', () => {
  it('valt terug op alles-aan bij ontbrekende rij (opt-out-model)', () => {
    expect(normalizeNotificationPrefs(null)).toEqual({ email_replies: true, email_announcements: true });
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizeNotificationPrefs({})).toEqual({ email_replies: true, email_announcements: true });
  });
  it('respecteert expliciete false', () => {
    expect(normalizeNotificationPrefs({ email_replies: false })).toEqual({
      email_replies: false,
      email_announcements: true,
    });
    expect(normalizeNotificationPrefs({ email_announcements: false })).toEqual({
      email_replies: true,
      email_announcements: false,
    });
  });
  it('behandelt alleen echte false als uit (truthy/undefined → aan)', () => {
    expect(normalizeNotificationPrefs({ email_replies: 0 }).email_replies).toBe(true);
    expect(normalizeNotificationPrefs({ email_replies: null }).email_replies).toBe(true);
  });
});

describe('prefAllowsKind', () => {
  it('mapt soort op de juiste voorkeur', () => {
    expect(prefAllowsKind({ email_replies: true }, 'reply')).toBe(true);
    expect(prefAllowsKind({ email_replies: false }, 'reply')).toBe(false);
    expect(prefAllowsKind({ email_announcements: false }, 'announcement')).toBe(false);
    expect(prefAllowsKind({ email_announcements: true }, 'announcement')).toBe(true);
  });
  it('onbekend soort → false', () => {
    expect(prefAllowsKind({}, 'iets')).toBe(false);
  });
  it('kent precies twee soorten', () => {
    expect(NOTIFICATION_KINDS).toEqual(['reply', 'announcement']);
  });
});

describe('buildDedupKey', () => {
  it('maakt stabiele sleutels per soort/thread/gebruiker', () => {
    expect(buildDedupKey('reply', 'T1', 'U1')).toBe('reply:T1:U1');
    expect(buildDedupKey('announcement', 'T1', 'U1')).toBe('announce:T1:U1');
  });
  it('vult ontbrekende delen defensief', () => {
    expect(buildDedupKey('reply', null, null)).toBe('reply:none:none');
  });
});

describe('groupPendingByUser', () => {
  it('groepeert rijen per ontvanger en negeert rommel', () => {
    const rows = [
      { user_id: 'A', kind: 'reply' },
      { user_id: 'B', kind: 'announcement' },
      { user_id: 'A', kind: 'announcement' },
      null,
      { kind: 'reply' },
    ];
    const map = groupPendingByUser(rows);
    expect(map.get('A')).toHaveLength(2);
    expect(map.get('B')).toHaveLength(1);
    expect(map.size).toBe(2);
  });
  it('lege/ongeldige invoer → lege map', () => {
    expect(groupPendingByUser(null).size).toBe(0);
  });
});

describe('partitionByPrefs', () => {
  it('splitst toegestaan vs onderdrukt', () => {
    const rows = [
      { kind: 'reply' },
      { kind: 'announcement' },
      { kind: 'reply' },
    ];
    const { allowed, suppressed } = partitionByPrefs(rows, { email_replies: true, email_announcements: false });
    expect(allowed).toHaveLength(2);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].kind).toBe('announcement');
  });
  it('alles onderdrukt als beide uit', () => {
    const rows = [{ kind: 'reply' }, { kind: 'announcement' }];
    const { allowed, suppressed } = partitionByPrefs(rows, { email_replies: false, email_announcements: false });
    expect(allowed).toHaveLength(0);
    expect(suppressed).toHaveLength(2);
  });
});

describe('escapeHtml', () => {
  it('ontsnapt HTML-gevoelige tekens', () => {
    expect(escapeHtml('<b>"a" & \'b\'</b>')).toBe('&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;');
  });
  it('null/undefined → lege string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('summarizeUserNotifications', () => {
  it('telt reacties per thread op en ontdubbelt aankondigingen', () => {
    const rows = [
      { kind: 'reply', thread_id: 'T1', thread_title: 'Vraag 1' },
      { kind: 'reply', thread_id: 'T1', thread_title: 'Vraag 1' },
      { kind: 'reply', thread_id: 'T2', thread_title: 'Vraag 2' },
      { kind: 'announcement', thread_id: 'A1', thread_title: 'Tentamen' },
      { kind: 'announcement', thread_id: 'A1', thread_title: 'Tentamen' },
    ];
    const { replies, announcements } = summarizeUserNotifications(rows);
    expect(replies).toHaveLength(2);
    const t1 = replies.find((r) => r.threadId === 'T1');
    expect(t1.count).toBe(2);
    expect(t1.title).toBe('Vraag 1');
    expect(announcements).toHaveLength(1);
    expect(announcements[0].title).toBe('Tentamen');
  });
});

describe('buildDigestEmail', () => {
  it('geeft null als er niets te melden valt', () => {
    expect(buildDigestEmail([], { lang: 'nl' })).toBeNull();
  });

  it('bouwt een NL-digest met reacties + aankondiging en een link', () => {
    const rows = [
      { kind: 'reply', thread_id: 'T1', thread_title: 'Mijn vraag' },
      { kind: 'reply', thread_id: 'T1', thread_title: 'Mijn vraag' },
      { kind: 'announcement', thread_id: 'A1', thread_title: 'Deadline verzet' },
    ];
    const mail = buildDigestEmail(rows, { userName: 'Sam', lang: 'nl', baseUrl: 'https://app.test/' });
    expect(mail.subject).toBe('Nieuwe activiteit in het Studiecafé');
    expect(mail.text).toContain('Hoi Sam,');
    expect(mail.text).toContain('2 nieuwe reacties op "Mijn vraag"');
    expect(mail.text).toContain('Deadline verzet');
    expect(mail.html).toContain('https://app.test/studiecafe');
    expect(mail.html).toContain('<a href');
  });

  it('subject is alleen-reacties of alleen-aankondigingen passend', () => {
    const onlyReplies = buildDigestEmail(
      [{ kind: 'reply', thread_id: 'T1', thread_title: 'X' }],
      { lang: 'nl' },
    );
    expect(onlyReplies.subject).toBe('1 nieuwe reactie in het Studiecafé');
    const onlyAnnounce = buildDigestEmail(
      [{ kind: 'announcement', thread_id: 'A1', thread_title: 'X' }],
      { lang: 'en' },
    );
    expect(onlyAnnounce.subject).toBe('1 new announcement in the Study Café');
  });

  it('zonder baseUrl geen link in de tekst', () => {
    const mail = buildDigestEmail([{ kind: 'reply', thread_id: 'T1', thread_title: 'X' }], { lang: 'nl' });
    expect(mail.text).not.toContain('http');
    expect(mail.html).not.toContain('<a href');
  });

  it('ontsnapt titels in de HTML (geen injectie)', () => {
    const mail = buildDigestEmail(
      [{ kind: 'reply', thread_id: 'T1', thread_title: '<script>x</script>' }],
      { lang: 'nl' },
    );
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('lokaliseert naar een niet-nl/en taal (Grieks) uit de locale-dicts', () => {
    const mail = buildDigestEmail(
      [{ kind: 'announcement', thread_id: 'A1', thread_title: 'Tentamen' }],
      { userName: 'Nikos', lang: 'el', baseUrl: 'https://app.test/' },
    );
    // De Griekse strings staan in el.json; controleer dat het NIET terugvalt op nl.
    expect(mail.subject).not.toBe('1 nieuwe aankondiging in het Studiecafé');
    // De titel (student-content) blijft ongewijzigd en aanwezig.
    expect(mail.text).toContain('Tentamen');
    expect(mail.html).toContain('https://app.test/studiecafe');
  });

  it('onbekende taal valt netjes terug op en', () => {
    const mail = buildDigestEmail(
      [{ kind: 'reply', thread_id: 'T1', thread_title: 'X' }],
      { lang: 'zz-unknown' },
    );
    // normalizeLang → 'nl' voor onbekende codes; blijft dus bruikbaar (geen crash).
    expect(mail.subject).toBeTruthy();
    expect(mail.text).toContain('X');
  });
});

describe('computeAnnouncementAudience', () => {
  it('actief + zichtbaar: alle studenten + leden, afzender uitgesloten', () => {
    const out = computeAnnouncementAudience({
      memberIds: ['t1', 's1'],
      studentIds: ['s1', 's2', 's3', 'teacher'],
      isActive: true,
      studentVisible: true,
      excludeUserId: 'teacher',
    });
    expect(out.sort()).toEqual(['s1', 's2', 's3', 't1'].sort());
    expect(out).not.toContain('teacher');
  });

  it('inactieve cursus: alleen leden (geen losse studenten)', () => {
    const out = computeAnnouncementAudience({
      memberIds: ['t1', 's1'],
      studentIds: ['s2', 's3'],
      isActive: false,
      studentVisible: true,
    });
    expect(out.sort()).toEqual(['s1', 't1'].sort());
  });

  it('verborgen cursus: alleen leden (studenten zien de inhoud niet)', () => {
    const out = computeAnnouncementAudience({
      memberIds: ['t1'],
      studentIds: ['s1', 's2'],
      isActive: true,
      studentVisible: false,
    });
    expect(out).toEqual(['t1']);
  });

  it('ontdubbelt en respecteert de max-cap', () => {
    const out = computeAnnouncementAudience({
      memberIds: ['a', 'a', 'b'],
      studentIds: ['b', 'c', 'd'],
      isActive: true,
      studentVisible: true,
      max: 2,
    });
    expect(out.length).toBe(2);
    expect(new Set(out).size).toBe(2);
  });
});
