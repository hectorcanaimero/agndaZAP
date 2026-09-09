'use client';

import Script from 'next/script';
import { useEffect } from 'react';
import {
  analyticsEnabled,
  PLAUSIBLE_DOMAIN,
  PLAUSIBLE_HOST,
  track,
  type AnalyticsEvent,
} from '@/lib/analytics';

const VIEW_EVENTS = new Set<AnalyticsEvent>(['hero_view', 'lead_form_view']);
const CLICK_EVENTS = new Set<AnalyticsEvent>(['cta_click']);

/**
 * Carga Plausible (si está configurado) y captura por delegación:
 *
 * - Clicks: cualquier elemento con `data-analytics="cta_click"` y opcional
 *   `data-analytics-location="hero|hero-whatsapp|nav|pricing|final|final-whatsapp"`. Así los CTAs de los
 *   server components del landing se instrumentan sin volverlos client.
 * - Vistas: elementos con `data-analytics-view="hero_view|lead_form_view"`,
 *   disparadas una sola vez cuando el 50% entra en viewport.
 *
 * Los eventos con lógica propia (lead_submitted, slot_selected,
 * appointment_created) se disparan desde sus componentes con `track()`.
 */
export function Analytics() {
  useEffect(() => {
    if (!analyticsEnabled) return;

    const onClick = (e: MouseEvent) => {
      const target = (e.target as Element | null)?.closest<HTMLElement>(
        '[data-analytics]',
      );
      if (!target) return;
      const event = target.dataset.analytics as AnalyticsEvent | undefined;
      if (!event || !CLICK_EVENTS.has(event)) return;
      const location = target.dataset.analyticsLocation;
      track(event, location ? { location } : undefined);
    };
    document.addEventListener('click', onClick, { capture: true });

    const seen = new WeakSet<Element>();
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-analytics-view]'),
    );
    let observer: IntersectionObserver | null = null;
    if (nodes.length > 0 && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || seen.has(entry.target)) continue;
            const el = entry.target as HTMLElement;
            const event = el.dataset.analyticsView as AnalyticsEvent | undefined;
            if (event && VIEW_EVENTS.has(event)) {
              seen.add(el);
              track(event);
              observer?.unobserve(el);
            }
          }
        },
        { threshold: 0.5 },
      );
      nodes.forEach((n) => observer?.observe(n));
    }

    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      observer?.disconnect();
    };
  }, []);

  if (!analyticsEnabled || !PLAUSIBLE_DOMAIN) return null;

  return (
    <Script
      // `script.js` básico: pageviews + eventos custom via window.plausible.
      src={`${PLAUSIBLE_HOST}/js/script.js`}
      data-domain={PLAUSIBLE_DOMAIN}
      strategy="afterInteractive"
    />
  );
}
