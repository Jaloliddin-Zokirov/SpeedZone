// Central site metadata used across SEO surfaces (layout metadata, JSON-LD,
// sitemap, robots). The base URL is resolved from env so it stays correct
// across local dev, Netlify deploy previews and production.
//   - NEXT_PUBLIC_SITE_URL: set this to the canonical production domain.
//   - URL: injected automatically by Netlify at build time.
function resolveSiteUrl() {
  const candidate =
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.URL ??
    process.env.DEPLOY_PRIME_URL ??
    'https://speedzone.netlify.app';
  return candidate.replace(/\/+$/, '');
}

export const SITE_URL = resolveSiteUrl();

export const SITE = {
  name: 'SpeedZone',
  shortName: 'SpeedZone',
  url: SITE_URL,
  title: 'SpeedZone — Free Internet Speed Test for Ping, Download & Upload',
  description:
    'Test your internet speed instantly with SpeedZone. Measure real-time ping (latency), jitter, download and upload speeds with a fast, accurate, multi-threaded speed test. A modern, ad-free alternative to Fast.com and Speedtest.',
  keywords: [
    'internet speed test',
    'speed test',
    'wifi speed test',
    'broadband speed test',
    'download speed test',
    'upload speed test',
    'ping test',
    'latency test',
    'jitter test',
    'bandwidth test',
    'network speed test',
    'fast internet test',
    'speedtest alternative',
    'fast.com alternative',
  ],
  locale: 'en_US',
  twitter: '@speedzone',
  themeColor: '#050b1f',
} as const;
