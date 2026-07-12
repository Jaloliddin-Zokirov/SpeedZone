import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import { SITE, SITE_URL } from "../lib/site";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE.title,
    template: `%s · ${SITE.name}`,
  },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [...SITE.keywords],
  authors: [{ name: SITE.name }],
  creator: SITE.name,
  publisher: SITE.name,
  category: "technology",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE.name,
    title: SITE.title,
    description: SITE.description,
    locale: SITE.locale,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.title,
    description: SITE.description,
    creator: SITE.twitter,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: SITE.themeColor,
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE.name,
      url: SITE_URL,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any (web browser)",
      browserRequirements: "Requires JavaScript. Works in any modern browser.",
      description: SITE.description,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "Real-time ping and latency measurement",
        "Jitter measurement",
        "Multi-threaded download speed test",
        "Multi-threaded upload speed test",
        "Public IP, ISP and location detection",
        "Selectable test servers",
      ],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE.name,
      description: SITE.description,
      inLanguage: "en",
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: [
        {
          "@type": "Question",
          name: "How does SpeedZone measure my internet speed?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "SpeedZone runs the test directly in your browser. It first measures ping and jitter with repeated lightweight requests, then measures download and upload throughput using multiple parallel connections to nearby Cloudflare test endpoints, giving an accurate picture of your real-world connection speed.",
          },
        },
        {
          "@type": "Question",
          name: "Is SpeedZone free to use?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. SpeedZone is completely free, requires no sign-up, and has no ads. Just open the page and press Go.",
          },
        },
        {
          "@type": "Question",
          name: "What is a good internet speed?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "For HD streaming and browsing, 25 Mbps download is comfortable. For 4K streaming, video calls and multiple devices, 100 Mbps or more is recommended. Lower ping (under 30 ms) and low jitter matter most for gaming and video calls.",
          },
        },
        {
          "@type": "Question",
          name: "What is the difference between ping, download and upload?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Ping (latency) is how quickly your connection responds, measured in milliseconds. Download speed is how fast you receive data. Upload speed is how fast you send data. All three are measured in a single SpeedZone test.",
          },
        },
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className} suppressHydrationWarning>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
