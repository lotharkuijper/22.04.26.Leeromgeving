import type { ReactNode } from 'react';

export type BannerPosition = 'top' | 'bottom' | 'left' | 'right' | 'background';
export type BannerFocal = 'top' | 'center' | 'bottom';

export interface CourseBanner {
  url: string;
  position: BannerPosition;
  height: number;
  opacity: number;
  focal: BannerFocal;
  alt: string;
}

const CARD =
  'rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-md shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(15,23,42,0.15)]';

function objectPositionFor(focal: BannerFocal): string {
  if (focal === 'top') return 'center top';
  if (focal === 'bottom') return 'center bottom';
  return 'center';
}

/**
 * Presentational frame voor het cursus-info-blok met optionele banner.
 * Wordt gedeeld door het Dashboard (studentweergave) en het beheer-voorbeeld,
 * zodat beide exact dezelfde layout en leesbaarheidssluier gebruiken.
 */
export function CourseBannerFrame({
  banner,
  children,
  className = '',
  testId,
}: {
  banner: CourseBanner | null;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  if (!banner || !banner.url) {
    return (
      <section className={`${CARD} p-6 md:p-8 ${className}`} data-testid={testId}>
        {children}
      </section>
    );
  }

  const objectPosition = objectPositionFor(banner.focal);
  const alt = banner.alt || '';
  const decorative = alt.length === 0;

  if (banner.position === 'background') {
    return (
      <section className={`${CARD} relative overflow-hidden ${className}`} data-testid={testId}>
        <img
          src={banner.url}
          alt={alt}
          aria-hidden={decorative ? true : undefined}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{ objectPosition, opacity: banner.opacity / 100 }}
          data-testid="img-course-banner"
        />
        {/* Automatische leesbaarheidssluier: garandeert leesbare tekst, ongeacht de afbeelding. */}
        <div className="pointer-events-none absolute inset-0 bg-white/70" aria-hidden="true" />
        <div className="relative p-6 md:p-8">{children}</div>
      </section>
    );
  }

  if (banner.position === 'left' || banner.position === 'right') {
    const side = (
      <div className="w-full flex-shrink-0 md:w-2/5">
        <img
          src={banner.url}
          alt={alt}
          aria-hidden={decorative ? true : undefined}
          className="w-full object-cover"
          style={{ objectPosition, height: banner.height }}
          data-testid="img-course-banner"
        />
      </div>
    );
    return (
      <section className={`${CARD} overflow-hidden ${className}`} data-testid={testId}>
        <div className="md:flex md:items-start">
          {banner.position === 'left' && side}
          <div className="min-w-0 flex-1 p-6 md:p-8">{children}</div>
          {banner.position === 'right' && side}
        </div>
      </section>
    );
  }

  // top / bottom
  const img = (
    <img
      src={banner.url}
      alt={alt}
      aria-hidden={decorative ? true : undefined}
      className="w-full object-cover"
      style={{ objectPosition, height: banner.height }}
      data-testid="img-course-banner"
    />
  );
  return (
    <section className={`${CARD} overflow-hidden ${className}`} data-testid={testId}>
      {banner.position === 'top' && img}
      <div className="p-6 md:p-8">{children}</div>
      {banner.position === 'bottom' && img}
    </section>
  );
}
