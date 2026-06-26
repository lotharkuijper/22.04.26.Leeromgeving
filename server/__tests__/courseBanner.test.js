import { describe, it, expect } from 'vitest';
import {
  normalizeBannerSettings,
  isAllowedBannerImage,
  isAllowedBannerBuffer,
  sniffImageMagic,
  bannerExtFromName,
  BANNER_HEIGHT_MIN,
  BANNER_HEIGHT_MAX,
  BANNER_HEIGHT_DEFAULT,
  BANNER_OPACITY_DEFAULT,
  BANNER_ALT_MAX,
} from '../courseBanner.js';

// Bouw een buffer met magic-bytes gevolgd door opvulling (>= 12 bytes totaal).
function bufOf(bytes) {
  const b = Buffer.alloc(Math.max(16, bytes.length));
  for (let i = 0; i < bytes.length; i++) b[i] = bytes[i];
  return b;
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

describe('normalizeBannerSettings', () => {
  it('returns defaults for empty input', () => {
    expect(normalizeBannerSettings({}, {})).toEqual({
      position: 'top',
      focal: 'center',
      height: BANNER_HEIGHT_DEFAULT,
      opacity: BANNER_OPACITY_DEFAULT,
      alt: '',
    });
  });

  it('accepts valid values', () => {
    const s = normalizeBannerSettings(
      { position: 'background', focal: 'bottom', height: 320, opacity: 25, alt: '  Logo  ' },
      {}
    );
    expect(s).toEqual({ position: 'background', focal: 'bottom', height: 320, opacity: 25, alt: 'Logo' });
  });

  it('clamps height and opacity to bounds', () => {
    expect(normalizeBannerSettings({ height: 5, opacity: 5 }, {}).height).toBe(BANNER_HEIGHT_MIN);
    expect(normalizeBannerSettings({ height: 9999 }, {}).height).toBe(BANNER_HEIGHT_MAX);
    expect(normalizeBannerSettings({ opacity: 999 }, {}).opacity).toBe(100);
    expect(normalizeBannerSettings({ opacity: 1 }, {}).opacity).toBe(10);
  });

  it('falls back to invalid -> base -> default', () => {
    const base = { banner_position: 'left', banner_height: 400, banner_opacity: 40, banner_focal: 'top', banner_alt: 'keep' };
    const s = normalizeBannerSettings({ position: 'nope', height: 'x', opacity: null }, base);
    expect(s).toEqual({ position: 'left', focal: 'top', height: 400, opacity: 40, alt: 'keep' });
  });

  it('supports plain-key base objects too', () => {
    const s = normalizeBannerSettings({}, { position: 'right', height: 150, opacity: 60, focal: 'bottom', alt: 'x' });
    expect(s).toEqual({ position: 'right', focal: 'bottom', height: 150, opacity: 60, alt: 'x' });
  });

  it('rejects invalid enums to default', () => {
    const s = normalizeBannerSettings({ position: 'diagonal', focal: 'middle' }, {});
    expect(s.position).toBe('top');
    expect(s.focal).toBe('center');
  });

  it('strips control chars and caps alt length', () => {
    const long = 'a'.repeat(BANNER_ALT_MAX + 50);
    const s = normalizeBannerSettings({ alt: `line1\nline2\t${long}` }, {});
    expect(s.alt).not.toMatch(/[\n\t]/);
    expect(s.alt.length).toBe(BANNER_ALT_MAX);
  });

  it('is defensive against non-object input', () => {
    expect(normalizeBannerSettings(null, null).position).toBe('top');
    expect(normalizeBannerSettings(undefined).height).toBe(BANNER_HEIGHT_DEFAULT);
  });
});

describe('bannerExtFromName', () => {
  it('extracts lowercased extension', () => {
    expect(bannerExtFromName('Photo.JPG')).toBe('jpg');
    expect(bannerExtFromName('a.b.webp')).toBe('webp');
  });
  it('returns empty for no extension', () => {
    expect(bannerExtFromName('noext')).toBe('');
    expect(bannerExtFromName(null)).toBe('');
  });
});

describe('isAllowedBannerImage', () => {
  it('accepts common raster image types', () => {
    expect(isAllowedBannerImage('image/png', 'png')).toBe(true);
    expect(isAllowedBannerImage('image/jpeg', 'jpg')).toBe(true);
    expect(isAllowedBannerImage('image/webp', 'webp')).toBe(true);
    expect(isAllowedBannerImage('image/avif', 'avif')).toBe(true);
  });
  it('rejects SVG by mime or extension', () => {
    expect(isAllowedBannerImage('image/svg+xml', 'svg')).toBe(false);
    expect(isAllowedBannerImage('image/png', 'svg')).toBe(false);
    expect(isAllowedBannerImage('image/svg+xml', 'png')).toBe(false);
  });
  it('rejects non-image and mismatched types', () => {
    expect(isAllowedBannerImage('application/pdf', 'pdf')).toBe(false);
    expect(isAllowedBannerImage('text/html', 'html')).toBe(false);
    expect(isAllowedBannerImage('', '')).toBe(false);
  });
});

describe('sniffImageMagic / isAllowedBannerBuffer', () => {
  it('detects PNG', () => {
    const png = bufOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImageMagic(png)).toBe('png');
    expect(isAllowedBannerBuffer(png)).toBe(true);
  });
  it('detects JPEG', () => {
    const jpg = bufOf([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffImageMagic(jpg)).toBe('jpeg');
  });
  it('detects GIF87a and GIF89a', () => {
    expect(sniffImageMagic(bufOf(ascii('GIF87a')))).toBe('gif');
    expect(sniffImageMagic(bufOf(ascii('GIF89a')))).toBe('gif');
  });
  it('detects WebP (RIFF....WEBP)', () => {
    const webp = bufOf([...ascii('RIFF'), 0x10, 0x00, 0x00, 0x00, ...ascii('WEBP')]);
    expect(sniffImageMagic(webp)).toBe('webp');
  });
  it('detects AVIF (ftyp box with avif brand)', () => {
    const avif = bufOf([0x00, 0x00, 0x00, 0x20, ...ascii('ftyp'), ...ascii('avif'), 0x00, 0x00, 0x00, 0x00]);
    expect(sniffImageMagic(avif)).toBe('avif');
  });
  it('rejects SVG / text / empty / too-short buffers', () => {
    expect(sniffImageMagic(bufOf(ascii('<svg xmlns=')))).toBe(null);
    expect(sniffImageMagic(bufOf(ascii('<!DOCTYPE html>')))).toBe(null);
    expect(sniffImageMagic(Buffer.alloc(0))).toBe(null);
    expect(sniffImageMagic(Buffer.from([0x89, 0x50]))).toBe(null);
    expect(sniffImageMagic(null)).toBe(null);
    expect(isAllowedBannerBuffer(bufOf(ascii('<svg xmlns=')))).toBe(false);
  });
});
