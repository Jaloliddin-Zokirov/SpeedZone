'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Phase = 'idle' | 'ping' | 'download' | 'upload' | 'complete' | 'error';

type ProgressState = {
  ping: number;
  download: number;
  upload: number;
};

type ServerInfo = {
  id: string;
  city: string;
  country: string;
  provider: string;
  downloadUrl?: string;
  uploadUrl?: string;
  downloadBytes?: number;
  metaUrl?: string;
};

const DEFAULT_REMOTE_DOWNLOAD_URL = 'https://speed.cloudflare.com/__down';
const DEFAULT_REMOTE_UPLOAD_URL = 'https://speed.cloudflare.com/__up';
const DEFAULT_REMOTE_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const SERVER_POOL: ServerInfo[] = [
  {
    id: 'cloudflare-auto',
    city: 'Automatic',
    country: 'Nearest Cloudflare POP',
    provider: 'Cloudflare',
    downloadUrl: process.env.NEXT_PUBLIC_SpeedZone_DOWNLOAD_URL ?? DEFAULT_REMOTE_DOWNLOAD_URL,
    uploadUrl: process.env.NEXT_PUBLIC_SpeedZone_UPLOAD_URL ?? DEFAULT_REMOTE_UPLOAD_URL,
    downloadBytes:
      Number(process.env.NEXT_PUBLIC_SpeedZone_DOWNLOAD_BYTES ?? DEFAULT_REMOTE_DOWNLOAD_BYTES) ||
      DEFAULT_REMOTE_DOWNLOAD_BYTES,
    metaUrl: 'https://speed.cloudflare.com/meta',
  },
  { id: 'tashkent-uztelecom', city: 'Tashkent', country: 'Uzbekistan', provider: 'Uztelecom' },
  { id: 'samarkand-ums', city: 'Samarkand', country: 'Uzbekistan', provider: 'UMS Mobile' },
  { id: 'namangan-ucell', city: 'Namangan', country: 'Uzbekistan', provider: 'Ucell' },
  { id: 'almaty-beeline', city: 'Almaty', country: 'Kazakhstan', provider: 'Beeline' },
  { id: 'frankfurt-hetzner', city: 'Frankfurt', country: 'Germany', provider: 'Hetzner' },
];

const PRIMARY_SERVER = SERVER_POOL[0] ?? {
  id: 'default',
  city: 'Auto',
  country: 'Unknown',
  provider: 'speed.cloudflare.com',
  downloadUrl: DEFAULT_REMOTE_DOWNLOAD_URL,
  uploadUrl: DEFAULT_REMOTE_UPLOAD_URL,
  downloadBytes: DEFAULT_REMOTE_DOWNLOAD_BYTES,
  metaUrl: 'https://speed.cloudflare.com/meta',
};

const DEFAULT_DOWNLOAD_URL = PRIMARY_SERVER.downloadUrl ?? DEFAULT_REMOTE_DOWNLOAD_URL;
const DEFAULT_UPLOAD_URL = PRIMARY_SERVER.uploadUrl ?? DEFAULT_REMOTE_UPLOAD_URL;
const DEFAULT_DOWNLOAD_BYTES = PRIMARY_SERVER.downloadBytes ?? DEFAULT_REMOTE_DOWNLOAD_BYTES;
const DEFAULT_REMOTE_HOST = extractHost(DEFAULT_DOWNLOAD_URL);

type NetworkInfo = {
  ip: string | null;
  isp: string | null;
  org: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
  loading: boolean;
  error: string | null;
};

type EndpointInfo = {
  host: string;
  colo: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  loading: boolean;
  error: string | null;
};

type PingProgress = (sampleMs: number, completedSamples: number, totalSamples: number) => void;
type SpeedProgress = (mbps: number, fraction: number) => void;

const SPEED_SCALES = [25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];

const STATUS_DETAIL: Record<Phase, string> = {
  idle: 'Click go to verify your connection performance.',
  ping: 'Finding the best route and measuring latency.',
  download: 'Measuring download throughput across multiple threads.',
  upload: 'Pushing data upstream to determine upload capacity.',
  complete: 'All tests complete. You can run the test again if you want.',
  error: 'We hit a problem while running the test. Please try again.',
};

function adjustSpeedScale(current: number, value: number) {
  if (!Number.isFinite(value)) return current;
  if (value <= current * 0.9) return current;
  for (const step of SPEED_SCALES) {
    if (value <= step) {
      return Math.max(step, current);
    }
  }
  return Math.max(Math.ceil(value / 200) * 200, current);
}

function formatSpeed(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return value.toFixed(0);
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatLatency(value: number | null) {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = ms / 1000;
  if (seconds < 10) return seconds.toFixed(2) + ' s';
  return seconds.toFixed(1) + ' s';
}

function gaugeValueText(phase: Phase, value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0.00';
  if (phase === 'ping') {
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }
  if (value >= 1000) return value.toFixed(0);
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatLocation(info: Pick<NetworkInfo, 'city' | 'region' | 'country'>) {
  const parts = [info.city, info.region, info.country].filter((part) => part && part.trim().length > 0);
  return parts.length ? parts.join(', ') : '—';
}

const MAX_RANDOM_CHUNK = 65_536;

function extractHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function makeRandomPayload(bytes: number) {
  const chunk = new Uint8Array(bytes);
  for (let offset = 0; offset < chunk.length; offset += MAX_RANDOM_CHUNK) {
    const end = Math.min(offset + MAX_RANDOM_CHUNK, chunk.length);
    crypto.getRandomValues(chunk.subarray(offset, end));
  }
  return chunk;
}

async function measurePing({
  rounds = 6,
  concurrency = 4,
  onProgress,
}: {
  rounds?: number;
  concurrency?: number;
  onProgress?: PingProgress;
} = {}) {
  const filtered: number[] = [];
  const totalSamples = rounds * concurrency;
  for (let round = 0; round < rounds; round++) {
    const batch: Promise<number>[] = [];
    for (let c = 0; c < concurrency; c++) {
      batch.push(
        (async () => {
          const t0 = performance.now();
          const res = await fetch('/api/ping', { cache: 'no-store' });
          if (!res.ok && res.status !== 204) {
            throw new Error(`Ping failed with status ${res.status}`);
          }
          return performance.now() - t0;
        })()
      );
    }
    const results = await Promise.all(batch);
    results.forEach((value, idx) => {
      const completed = round * concurrency + idx + 1;
      onProgress?.(value, completed, totalSamples);
    });
    filtered.push(...results.slice(1));
  }
  if (!filtered.length) {
    return { average: 0, jitter: 0, samples: [] as number[] };
  }
  const sum = filtered.reduce((acc, val) => acc + val, 0);
  const average = sum / filtered.length;
  const variance = filtered.reduce((acc, val) => acc + (val - average) ** 2, 0) / filtered.length;
  const jitter = Math.sqrt(Math.max(variance, 0));
  return { average, jitter, samples: filtered };
}

// Download uses the same XMLHttpRequest-based architecture as measureUpload
// below: bounded requests, onprogress-driven byte counting, a built-in
// per-request timeout, and automatic per-request fallback to the local
// endpoint. Streaming fetch + ReadableStream reads were tried first but
// proved unreliable across real-world networks (a stalled read could hang
// indefinitely); XHR's onprogress/timeout events are simpler and battle
// tested here by the upload path already working smoothly.
async function measureDownload({
  durationMs = 17_000,
  concurrency = 4,
  chunkSize = 4 * 1024 * 1024,
  remoteUrl,
  remoteBytes = DEFAULT_REMOTE_DOWNLOAD_BYTES,
  onProgress,
}: {
  durationMs?: number;
  concurrency?: number;
  chunkSize?: number;
  remoteUrl?: string | null;
  remoteBytes?: number;
  onProgress?: SpeedProgress;
} = {}) {
  const duration = Math.max(Math.floor(durationMs), 1_000);
  const requestBytes = Math.min(
    Math.max(Math.floor(chunkSize ?? 0) || 4 * 1024 * 1024, 512 * 1024),
    8 * 1024 * 1024
  );
  const xhrs = new Set<XMLHttpRequest>();
  const start = performance.now();
  const stopTime = start + duration;
  let stop = false;
  let totalBytes = 0;
  const remoteEndpoint = remoteUrl?.trim().length ? remoteUrl.trim() : null;
  let preferRemoteDownload = Boolean(remoteEndpoint);

  function abortAll() {
    const snapshot = Array.from(xhrs);
    snapshot.forEach((xhr) => {
      try {
        xhr.abort();
      } catch {
        /* noop */
      }
    });
  }

  const timer = window.setTimeout(() => {
    stop = true;
    abortAll();
  }, duration);

  function emitProgress() {
    const now = performance.now();
    const elapsed = Math.max(now - start, 0);
    if (elapsed <= 0) return;
    const seconds = elapsed / 1000;
    if (seconds <= 0) return;
    const mbps = (totalBytes * 8) / 1_000_000 / seconds;
    const fraction = Math.min(1, elapsed / duration);
    onProgress?.(mbps, fraction);
  }

  function runWorker() {
    return new Promise<void>((resolve) => {
      let settled = false;

      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const scheduleNext = () => {
        if (settled || stop || performance.now() >= stopTime) {
          complete();
          return;
        }
        dispatchDownload(preferRemoteDownload ? 'remote' : 'local');
      };

      const dispatchDownload = (mode: 'remote' | 'local') => {
        if (settled || stop) {
          complete();
          return;
        }
        if (mode === 'remote' && !remoteEndpoint) {
          setTimeout(() => dispatchDownload('local'), 0);
          return;
        }

        const cacheBust = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let url: string;
        if (mode === 'remote' && remoteEndpoint) {
          try {
            const inbound = new URL(remoteEndpoint);
            inbound.searchParams.set('bytes', String(requestBytes));
            inbound.searchParams.set('cacheBust', cacheBust);
            url = inbound.toString();
          } catch {
            setTimeout(() => dispatchDownload('local'), 0);
            return;
          }
        } else {
          url = `/api/download?bytes=${requestBytes}&chunk=${requestBytes}&cacheBust=${cacheBust}`;
        }

        const xhr = new XMLHttpRequest();
        xhrs.add(xhr);
        let lastLoaded = 0;

        xhr.open('GET', url);
        xhr.responseType = 'arraybuffer';
        // A per-request timeout stands in for stall detection: a connection
        // that stops delivering data is abandoned and replaced with a fresh
        // one instead of hanging for the rest of the test.
        xhr.timeout = 8000;

        const fallbackToLocal = () => {
          if (settled || stop) {
            return false;
          }
          preferRemoteDownload = false;
          setTimeout(() => dispatchDownload('local'), 0);
          return true;
        };

        xhr.onprogress = (event) => {
          if (stop) return;
          if (event.lengthComputable) {
            const delta = event.loaded - lastLoaded;
            if (delta > 0) {
              lastLoaded = event.loaded;
              totalBytes += delta;
              emitProgress();
            }
          }
          if (!stop && performance.now() >= stopTime) {
            stop = true;
          }
          if (stop) {
            try {
              xhr.abort();
            } catch {
              /* noop */
            }
          }
        };

        xhr.onload = () => {
          xhrs.delete(xhr);
          if (xhr.status >= 200 && xhr.status < 400) {
            const body = xhr.response as ArrayBuffer | null;
            const total = body ? body.byteLength : lastLoaded;
            const remaining = total - lastLoaded;
            if (remaining > 0 && !stop) {
              totalBytes += remaining;
              emitProgress();
            }
            if (!stop && performance.now() < stopTime) {
              setTimeout(scheduleNext, 0);
            } else {
              complete();
            }
            return;
          }
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }
          complete();
        };

        xhr.ontimeout = () => {
          xhrs.delete(xhr);
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }
          if (!stop && performance.now() < stopTime) {
            setTimeout(scheduleNext, 0);
          } else {
            complete();
          }
        };

        xhr.onerror = () => {
          xhrs.delete(xhr);
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }
          if (!stop && performance.now() < stopTime) {
            setTimeout(scheduleNext, 0);
          } else {
            complete();
          }
        };

        xhr.onabort = () => {
          xhrs.delete(xhr);
          complete();
        };

        try {
          xhr.send();
        } catch {
          xhrs.delete(xhr);
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }
          complete();
        }
      };

      scheduleNext();
    });
  }

  try {
    const workers = Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    // Hard safety deadline: xhr.abort() does not reliably fire onabort for
    // every in-flight cross-origin request, which can leave a single worker's
    // promise unresolved forever. This guarantees the measurement always
    // returns within duration + a grace window regardless.
    const guard = new Promise<void>((resolve) => {
      window.setTimeout(resolve, duration + 4000);
    });
    await Promise.race([workers, guard]);
  } finally {
    stop = true;
    window.clearTimeout(timer);
    abortAll();
    xhrs.clear();
  }

  const elapsedMs = Math.max(performance.now() - start, 1);
  const seconds = elapsedMs / 1000;
  const mbps = seconds > 0 ? (totalBytes * 8) / 1_000_000 / seconds : 0;
  onProgress?.(mbps, 1);
  return { mbps, bytes: totalBytes, seconds };
}

async function measureUpload({
  durationMs = 17_000,
  concurrency = 3,
  payloadBytes = 512 * 1024,
  remoteUrl,
  onProgress,
}: {
  durationMs?: number;
  concurrency?: number;
  payloadBytes?: number;
  remoteUrl?: string | null;
  onProgress?: SpeedProgress;
} = {}) {
  const duration = Math.max(Math.floor(durationMs), 1_000);
  const chunkBytes = Math.min(
    Math.max(Math.floor(payloadBytes ?? 0) || 512 * 1024, 128 * 1024),
    2 * 1024 * 1024
  );
  const uploads = new Set<XMLHttpRequest>();
  const start = performance.now();
  const stopTime = start + duration;
  let stop = false;
  let totalUploaded = 0;
  let lastAdvanceAt = start;
  let lastAdvanceBytes = 0;
  const remoteEndpoint = remoteUrl?.trim().length ? remoteUrl.trim() : null;
  let preferRemoteUpload = Boolean(remoteEndpoint);

  function abortAll() {
    const snapshot = Array.from(uploads);
    snapshot.forEach((xhr) => {
      try {
        xhr.abort();
      } catch {
        /* noop */
      }
    });
  }

  const timer = window.setTimeout(() => {
    stop = true;
    abortAll();
  }, duration);

  const STALL_MS = 6000;
  const stallTimer = window.setInterval(() => {
    if (stop) return;
    if (performance.now() - lastAdvanceAt > STALL_MS) {
      stop = true;
      abortAll();
    }
  }, 1000);

  function emitProgress() {
    const now = performance.now();
    if (totalUploaded > lastAdvanceBytes) {
      lastAdvanceBytes = totalUploaded;
      lastAdvanceAt = now;
    }
    const elapsed = Math.max(now - start, 0);
    if (elapsed <= 0) return;
    const seconds = elapsed / 1000;
    if (seconds <= 0) return;
    const mbps = (totalUploaded * 8) / 1_000_000 / seconds;
    const fraction = Math.min(1, elapsed / duration);
    onProgress?.(mbps, fraction);
  }

  function runWorker() {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const scheduleNext = () => {
        if (settled || stop) {
          complete();
          return;
        }
        dispatchUpload(preferRemoteUpload ? 'remote' : 'local');
      };

      const dispatchUpload = (mode: 'remote' | 'local') => {
        if (settled || stop) {
          complete();
          return;
        }
        if (mode === 'remote' && !remoteEndpoint) {
          setTimeout(() => dispatchUpload('local'), 0);
          return;
        }

        const payload = makeRandomPayload(chunkBytes);
        const cacheBust = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const url =
          mode === 'remote'
            ? `${remoteEndpoint}?cacheBust=${cacheBust}`
            : `/api/upload?cacheBust=${cacheBust}`;

        const xhr = new XMLHttpRequest();
        uploads.add(xhr);
        let lastLoaded = 0;

        xhr.open('POST', url);
        xhr.responseType = 'text';

        const fallbackToLocal = () => {
          if (settled || stop) {
            return false;
          }
          preferRemoteUpload = false;
          setTimeout(() => dispatchUpload('local'), 0);
          return true;
        };

        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable || stop) return;
          const delta = event.loaded - lastLoaded;
          if (delta > 0) {
            lastLoaded = event.loaded;
            totalUploaded += delta;
            emitProgress();
          }
          if (!stop && performance.now() >= stopTime) {
            stop = true;
          }
          if (stop) {
            try {
              xhr.abort();
            } catch {
              /* noop */
            }
          }
        };

        xhr.onload = () => {
          uploads.delete(xhr);
          if (xhr.status >= 200 && xhr.status < 400) {
            const remaining = chunkBytes - lastLoaded;
            if (remaining > 0 && !stop) {
              totalUploaded += remaining;
              emitProgress();
            }
            if (!stop && performance.now() < stopTime) {
              setTimeout(scheduleNext, 0);
            } else {
              complete();
            }
            return;
          }
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }

          if (!stop) {
            stop = true;
            fail(new Error(`Upload failed with status ${xhr.status}`));
          } else {
            complete();
          }
        };

        xhr.onerror = () => {
          uploads.delete(xhr);
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }
          if (stop) {
            complete();
          } else {
            stop = true;
            fail(new Error('Upload request failed'));
          }
        };

        xhr.onabort = () => {
          uploads.delete(xhr);
          complete();
        };

        try {
          xhr.send(payload);
        } catch (err) {
          uploads.delete(xhr);
          if (mode === 'remote' && fallbackToLocal()) {
            return;
          }
          if (!stop) {
            stop = true;
            fail(err instanceof Error ? err : new Error(String(err)));
          } else {
            complete();
          }
        }
      };

      scheduleNext();
    });
  }

  try {
    const workers = Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    const guard = new Promise<void>((resolve) => {
      window.setTimeout(resolve, duration + 3000);
    });
    await Promise.race([workers, guard]);
  } finally {
    stop = true;
    window.clearTimeout(timer);
    window.clearInterval(stallTimer);
    abortAll();
    uploads.clear();
  }

  const elapsedMs = Math.max(performance.now() - start, 1);
  const seconds = elapsedMs / 1000;
  const mbps = seconds > 0 ? (totalUploaded * 8) / 1_000_000 / seconds : 0;
  onProgress?.(mbps, 1);
  return { mbps, bytes: totalUploaded, seconds };
}

type MetricAccent = 'ping' | 'jitter' | 'download' | 'upload';

const METRIC_ACCENTS: Record<
  MetricAccent,
  { text: string; bar: string; ring: string; glow: string; softBg: string }
> = {
  ping: {
    text: 'text-cyan-300',
    bar: 'from-cyan-400 to-sky-500',
    ring: 'border-cyan-400/60',
    glow: '0 12px 60px -30px rgba(34,211,238,0.85)',
    softBg: 'bg-cyan-400/10',
  },
  jitter: {
    text: 'text-violet-300',
    bar: 'from-violet-400 to-purple-500',
    ring: 'border-violet-400/60',
    glow: '0 12px 60px -30px rgba(167,139,250,0.85)',
    softBg: 'bg-violet-400/10',
  },
  download: {
    text: 'text-emerald-300',
    bar: 'from-emerald-400 to-teal-500',
    ring: 'border-emerald-400/60',
    glow: '0 12px 60px -30px rgba(52,211,153,0.85)',
    softBg: 'bg-emerald-400/10',
  },
  upload: {
    text: 'text-fuchsia-300',
    bar: 'from-fuchsia-400 to-pink-500',
    ring: 'border-fuchsia-400/60',
    glow: '0 12px 60px -30px rgba(232,121,249,0.85)',
    softBg: 'bg-fuchsia-400/10',
  },
};

function MetricIcon({ accent, className }: { accent: MetricAccent; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (accent === 'download') {
    return (
      <svg {...common}>
        <path d="M12 3v12" />
        <path d="m7 11 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    );
  }
  if (accent === 'upload') {
    return (
      <svg {...common}>
        <path d="M12 21V9" />
        <path d="m7 13 5-5 5 5" />
        <path d="M5 3h14" />
      </svg>
    );
  }
  if (accent === 'jitter') {
    return (
      <svg {...common}>
        <path d="M2 12h3l3 7 4-16 3 12 2-5h5" />
      </svg>
    );
  }
  // ping
  return (
    <svg {...common}>
      <path d="M2 12h5l2 5 4-12 2 9 2-4h5" />
    </svg>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles =
    status === 'TESTING' || status === 'CALC'
      ? 'border-amber-300/40 bg-amber-300/10 text-amber-200'
      : status === 'COMPLETE'
      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
      : status === 'ERROR'
      ? 'border-rose-400/40 bg-rose-400/10 text-rose-200'
      : 'border-white/10 bg-white/5 text-slate-400';
  const pulsing = status === 'TESTING' || status === 'CALC';
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.2em]',
        styles,
      ].join(' ')}
    >
      {pulsing ? (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
      ) : null}
      {status}
    </span>
  );
}

function MetricCard({
  label,
  value,
  unit,
  status,
  progress,
  active,
  accent,
}: {
  label: string;
  value: string;
  unit: string;
  status: string;
  progress?: number;
  active?: boolean;
  accent: MetricAccent;
}) {
  const showProgress = progress != null && progress < 0.995;
  const theme = METRIC_ACCENTS[accent];
  const hasValue = value !== '—';
  return (
    <div
      className={[
        'group relative overflow-hidden rounded-2xl border bg-white/5 p-5 transition-all duration-300',
        active
          ? theme.ring
          : 'border-white/10 shadow-[0_24px_70px_-55px_rgba(15,23,42,0.9)]',
      ].join(' ')}
      style={active ? { boxShadow: theme.glow } : undefined}
    >
      {active ? (
        <div
          className={`pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full ${theme.softBg} blur-2xl`}
        />
      ) : null}
      <div className="relative flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs uppercase tracking-[0.35em] text-slate-400">
          <span
            className={[
              'flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 transition-colors',
              active ? `${theme.softBg} ${theme.text}` : 'text-slate-500',
            ].join(' ')}
          >
            <MetricIcon accent={accent} className="h-4 w-4" />
          </span>
          {label}
        </span>
        <StatusPill status={status} />
      </div>
      <div className="relative mt-4 flex items-end gap-2">
        <span
          className={[
            'text-3xl font-semibold tabular-nums transition-colors',
            hasValue ? 'text-white' : 'text-slate-600',
          ].join(' ')}
        >
          {value}
        </span>
        <span className="pb-1 text-sm text-slate-400">{unit}</span>
      </div>
      <div className="relative mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-800/70">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${theme.bar} transition-[width] duration-200 ease-out`}
          style={{
            width: `${
              showProgress
                ? Math.max(progress ?? 0, 0.04) * 100
                : hasValue
                ? 100
                : 0
            }%`,
          }}
        />
      </div>
    </div>
  );
}

function SpeedGauge({
  phase,
  value,
  unit,
  max,
  status,
  detail,
  onStart,
  disabled,
  showButton,
  error,
}: {
  phase: Phase;
  value: number;
  unit: string;
  max: number;
  status: string;
  detail: string;
  onStart: () => void;
  disabled: boolean;
  showButton: boolean;
  error: string | null;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(value / max, 1)) : 0;
  const buttonLabel = phase === 'complete' ? 'Go Again' : phase === 'error' ? 'Retry' : 'Go';

  // The gauge picks up the colour of the metric currently being measured so
  // the whole test reads as one system with the metric cards below.
  const accent =
    phase === 'ping'
      ? { arc: 'rgba(34,211,238,0.9)', glow: 'rgba(34,211,238,0.4)', text: 'text-cyan-200', label: 'Ping' }
      : phase === 'download'
      ? { arc: 'rgba(52,211,153,0.9)', glow: 'rgba(52,211,153,0.4)', text: 'text-emerald-200', label: 'Download' }
      : phase === 'upload' || phase === 'complete'
      ? { arc: 'rgba(232,121,249,0.9)', glow: 'rgba(232,121,249,0.4)', text: 'text-fuchsia-200', label: phase === 'complete' ? 'Upload' : 'Upload' }
      : phase === 'error'
      ? { arc: 'rgba(251,113,133,0.9)', glow: 'rgba(251,113,133,0.35)', text: 'text-rose-200', label: 'Error' }
      : { arc: 'rgba(99,102,241,0.85)', glow: 'rgba(79,70,229,0.35)', text: 'text-indigo-200', label: 'Ready' };

  return (
    <div className="relative flex w-full flex-col items-center">
      <div
        className="pointer-events-none absolute inset-0 -z-10 rounded-full transition-colors duration-500"
        style={{ background: `radial-gradient(circle at 50% 20%, ${accent.glow}, transparent 65%)` }}
      />
      <div className="relative aspect-square w-full max-w-[24rem]">
        <div
          className="absolute inset-0 rounded-full border border-white/10 bg-gradient-to-br from-slate-900 via-slate-950 to-black transition-shadow duration-500"
          style={{ boxShadow: `0 0 120px ${accent.glow}` }}
        />
        <div
          className="absolute inset-[12%] rounded-full border border-white/5 transition-[background] duration-200"
          style={{
            background: `conic-gradient(from 225deg, ${accent.arc} ${ratio * 100}%, rgba(100,116,139,0.14) ${ratio * 100}% 100%)`,
          }}
        />
        <div className="absolute inset-[22%] rounded-full bg-slate-950/80 backdrop-blur-md">
          {showButton ? (
            <button
              type="button"
              onClick={onStart}
              disabled={disabled}
              className="group absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-full text-white"
            >
              <span className="rounded-full border border-white/10 bg-white/5 px-6 py-3 text-lg font-medium uppercase tracking-[0.5em] text-white/90 transition group-hover:scale-105 group-disabled:opacity-40">
                {buttonLabel}
              </span>
              <span className="text-xs uppercase tracking-[0.35em] text-slate-500">SpeedZone</span>
            </button>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
              <span className={`text-xs font-semibold uppercase tracking-[0.4em] ${accent.text}`}>
                {accent.label}
              </span>
              <span className="text-6xl font-semibold tabular-nums tracking-tight text-white drop-shadow-sm">
                {gaugeValueText(phase === 'complete' ? 'upload' : phase, value)}
              </span>
              <span className="text-sm uppercase tracking-[0.45em] text-slate-400">{unit}</span>
            </div>
          )}
        </div>
        {/* {!showButton ? (
          <div className="pointer-events-none absolute inset-[12%] flex items-center justify-center">
            <div
              className="relative h-[48%] w-1.5 transition-transform ease-out origin-bottom rounded-full bg-gradient-to-b from-slate-100 via-indigo-200 to-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.6)]"
              style={{ transform: `rotate(${angle}deg)` }}
            >
              <span className="absolute -top-2 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-indigo-200 shadow-[0_0_10px_rgba(129,140,248,0.8)]" />
            </div>
          </div>
        ) : null} */}
        <div className="pointer-events-none absolute inset-x-8 bottom-10 flex justify-between text-xs uppercase tracking-[0.3em] text-slate-500">
          <span>0</span>
          <span>{Math.round(max)}</span>
        </div>
      </div>
      <div className="mt-6 text-center">
        <div className="text-xs uppercase tracking-[0.4em] text-slate-400">{status}</div>
        <p className="mt-2 max-w-[22rem] text-sm text-slate-300">
          {error && phase === 'error' ? error : detail}
        </p>
      </div>
    </div>
  );
}

const INITIAL_RESULTS = { ping: null, jitter: null, download: null, upload: null } as {
  ping: number | null;
  jitter: number | null;
  download: number | null;
  upload: number | null;
};

export default function Page() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(INITIAL_RESULTS);
  const [progress, setProgress] = useState<ProgressState>({ ping: 0, download: 0, upload: 0 });
  const [liveValue, setLiveValue] = useState(0);
  const [speedScale, setSpeedScale] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo>({
    ip: null,
    isp: null,
    org: null,
    city: null,
    region: null,
    country: null,
    timezone: null,
    loading: true,
    error: null,
  });
  const [endpointInfo, setEndpointInfo] = useState<EndpointInfo>({
    host: DEFAULT_REMOTE_HOST,
    colo: null,
    city: null,
    region: null,
    country: null,
    loading: Boolean(PRIMARY_SERVER.metaUrl),
    error: null,
  });
  const [selectedServerId, setSelectedServerId] = useState(PRIMARY_SERVER.id);
  const [isServerPickerOpen, setServerPickerOpen] = useState(false);
  const runRef = useRef(0);

  const selectedServer = useMemo<ServerInfo>(() => {
    const match = SERVER_POOL.find((entry) => entry.id === selectedServerId);
    return match ?? PRIMARY_SERVER;
  }, [selectedServerId]);

  const selectedDownloadUrl = selectedServer.downloadUrl ?? DEFAULT_DOWNLOAD_URL;
  const selectedUploadUrl = selectedServer.uploadUrl ?? DEFAULT_UPLOAD_URL;
  const selectedDownloadBytes = selectedServer.downloadBytes ?? DEFAULT_DOWNLOAD_BYTES;
  const selectedMetaUrl = selectedServer.metaUrl ?? null;
  const selectedHost = useMemo(() => extractHost(selectedDownloadUrl), [selectedDownloadUrl]);

  useEffect(() => {
    let cancelled = false;
    async function fetchNetworkInfo() {
      try {
        const response = await fetch(
          'https://ipwho.is/?fields=success,message,ip,type,city,region,country,connection,timezone',
          { cache: 'no-store' }
        );
        if (!response.ok) {
          throw new Error(`Lookup failed with status ${response.status}`);
        }
        const data = await response.json();
        if (cancelled) return;
        if (data.success === false) {
          setNetworkInfo((prev) => ({
            ...prev,
            loading: false,
            error: data.message ?? 'Unable to detect network information',
          }));
          return;
        }
        setNetworkInfo({
          ip: data.ip ?? null,
          isp: data.connection?.isp ?? data.isp ?? data.org ?? null,
          org: data.connection?.org ?? data.org ?? null,
          city: data.city ?? null,
          region: data.region ?? data.region_name ?? null,
          country: data.country ?? data.country_name ?? null,
          timezone: data.timezone?.id ?? data.timezone ?? null,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setNetworkInfo((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'Unable to detect network information',
        }));
      }
    }
    fetchNetworkInfo();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setEndpointInfo({
      host: selectedHost,
      colo: null,
      city: null,
      region: null,
      country: null,
      loading: Boolean(selectedMetaUrl),
      error: null,
    });
  }, [selectedHost, selectedMetaUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedMetaUrl) {
      setEndpointInfo((prev) => ({
        ...prev,
        host: selectedHost,
        loading: false,
        error: null,
      }));
      return () => {
        cancelled = true;
      };
    }
    const metaUrl = selectedMetaUrl;
    async function fetchEndpointMeta() {
      try {
        const response = await fetch(metaUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Lookup failed with status ${response.status}`);
        }
        const data = await response.json();
        if (cancelled) return;
        // Cloudflare's /meta endpoint now returns `colo` as an object
        // ({ iata, lat, lon, cca2, region, city }) instead of a plain string.
        // Normalize both shapes so we never render an object as a React child.
        const coloRaw = data.colo;
        const coloObject =
          coloRaw && typeof coloRaw === 'object' ? (coloRaw as Record<string, unknown>) : null;
        const asStringOrNull = (value: unknown) =>
          typeof value === 'string' && value.trim().length > 0 ? value : null;
        const colo = coloObject
          ? asStringOrNull(coloObject.iata) ?? asStringOrNull(coloObject.city)
          : asStringOrNull(coloRaw);
        setEndpointInfo((prev) => ({
          ...prev,
          host: selectedHost,
          colo,
          city: asStringOrNull(data.city) ?? (coloObject ? asStringOrNull(coloObject.city) : null),
          region:
            asStringOrNull(data.region) ?? (coloObject ? asStringOrNull(coloObject.region) : null),
          country:
            asStringOrNull(data.country) ?? (coloObject ? asStringOrNull(coloObject.cca2) : null),
          loading: false,
          error: null,
        }));
      } catch (err) {
        if (cancelled) return;
        setEndpointInfo((prev) => ({
          ...prev,
          host: selectedHost,
          loading: false,
          error:
            err instanceof Error
              ? `Unable to resolve remote test location: ${err.message}`
              : 'Unable to resolve remote test location',
        }));
      }
    }
    fetchEndpointMeta();
    return () => {
      cancelled = true;
    };
  }, [selectedMetaUrl, selectedHost]);

  const serverDisplay = useMemo<ServerInfo>(() => {
    const providerLabel =
      selectedServer.provider.trim().length > 0 ? selectedServer.provider : selectedHost;
    return {
      ...selectedServer,
      provider: providerLabel,
      city: endpointInfo.city ?? endpointInfo.colo ?? selectedServer.city,
      country: endpointInfo.country ?? selectedServer.country,
    };
  }, [endpointInfo.city, endpointInfo.colo, endpointInfo.country, selectedHost, selectedServer]);
  const hostLabel = endpointInfo.host ?? selectedHost;
  const remoteConfigured = Boolean(
    selectedServer.downloadUrl?.trim() && selectedServer.uploadUrl?.trim()
  );
  const handleServerSelect = useCallback((id: string) => {
    setSelectedServerId(id);
    setServerPickerOpen(false);
  }, []);

  const startTest = useCallback(async () => {
    if (running) return;
    const runId = runRef.current + 1;
    runRef.current = runId;
    setError(null);
    setDurationMs(0);
    setPhase('ping');
    setRunning(true);
    setResults({ ...INITIAL_RESULTS });
    setProgress({ ping: 0, download: 0, upload: 0 });
    setLiveValue(0);
    setSpeedScale(100);

    const testStart = performance.now();

    try {
      const ping = await measurePing({
        rounds: 6,
        concurrency: 4,
        onProgress: (sample, completed, total) => {
          if (runRef.current !== runId) return;
          setProgress((prev) => ({ ...prev, ping: completed / total }));
          setLiveValue(sample);
        },
      });
      if (runRef.current !== runId) return;
      setResults((prev) => ({ ...prev, ping: ping.average, jitter: ping.jitter }));
      setProgress((prev) => ({ ...prev, ping: 1 }));
      setLiveValue(ping.average);

      setPhase('download');
      const downloadOnProgress = (mbps: number, fraction: number) => {
        if (runRef.current !== runId) return;
        setLiveValue(mbps);
        setSpeedScale((prev) => adjustSpeedScale(prev, mbps));
        setProgress((prev) => ({ ...prev, download: fraction }));
      };
      let download = await measureDownload({
        durationMs: 17_000,
        concurrency: 4,
        chunkSize: 256 * 1024,
        remoteUrl: selectedDownloadUrl,
        remoteBytes: selectedDownloadBytes,
        onProgress: downloadOnProgress,
      });
      if (runRef.current !== runId) return;
      // If the remote endpoint yielded no data (aborted/blocked connection),
      // fall back to the local streaming endpoint so a completed test never
      // reports an empty "—" result.
      if (!(download.mbps > 0) || download.bytes === 0) {
        setProgress((prev) => ({ ...prev, download: 0 }));
        const localDownload = await measureDownload({
          durationMs: 12_000,
          concurrency: 4,
          chunkSize: 256 * 1024,
          remoteUrl: null,
          onProgress: downloadOnProgress,
        });
        if (runRef.current !== runId) return;
        if (localDownload.mbps > download.mbps) {
          download = localDownload;
        }
      }
      setResults((prev) => ({ ...prev, download: download.mbps }));
      setProgress((prev) => ({ ...prev, download: 1 }));
      setLiveValue(download.mbps);

      setPhase('upload');
      const uploadOnProgress = (mbps: number, fraction: number) => {
        if (runRef.current !== runId) return;
        setLiveValue(mbps);
        setSpeedScale((prev) => adjustSpeedScale(prev, mbps));
        setProgress((prev) => ({ ...prev, upload: fraction }));
      };
      let upload = await measureUpload({
        durationMs: 17_000,
        concurrency: 3,
        payloadBytes: 512 * 1024,
        remoteUrl: selectedUploadUrl,
        onProgress: uploadOnProgress,
      });
      if (runRef.current !== runId) return;
      // Same safeguard for upload: fall back to the local endpoint if the
      // remote upload produced no measurable data.
      if (!(upload.mbps > 0) || upload.bytes === 0) {
        setProgress((prev) => ({ ...prev, upload: 0 }));
        const localUpload = await measureUpload({
          durationMs: 12_000,
          concurrency: 3,
          payloadBytes: 512 * 1024,
          remoteUrl: null,
          onProgress: uploadOnProgress,
        });
        if (runRef.current !== runId) return;
        if (localUpload.mbps > upload.mbps) {
          upload = localUpload;
        }
      }
      setResults((prev) => ({ ...prev, upload: upload.mbps }));
      setProgress((prev) => ({ ...prev, upload: 1 }));
      setLiveValue(upload.mbps);
      setPhase('complete');
      setDurationMs(performance.now() - testStart);
    } catch (err) {
      if (runRef.current !== runId) return;
      console.error(err);
      setError(err instanceof Error ? err.message : 'Unexpected error');
      setPhase('error');
    } finally {
      if (runRef.current === runId) {
        setRunning(false);
      }
    }
  }, [running, selectedDownloadUrl, selectedDownloadBytes, selectedUploadUrl]);

  const gaugeUnit = phase === 'ping' ? 'ms' : 'Mbps';
  const gaugeMax = phase === 'ping' ? 250 : speedScale;
  const showGaugeButton = phase === 'idle' || phase === 'complete' || phase === 'error';
  const statusDetail = STATUS_DETAIL[phase];
  const statusLabel =
    phase === 'idle'
      ? 'READY'
      : phase === 'error'
      ? 'ERROR'
      : phase === 'complete'
      ? 'COMPLETE'
      : phase.toUpperCase();
  const testDuration = formatDuration(durationMs);

  const pingStatus =
    phase === 'ping' ? 'TESTING' : results.ping != null ? 'COMPLETE' : phase === 'error' ? 'ERROR' : 'READY';
  const jitterStatus =
    phase === 'ping' ? 'CALC' : results.jitter != null ? 'COMPLETE' : phase === 'error' ? 'ERROR' : 'READY';
  const downloadStatus =
    phase === 'download' ? 'TESTING' : results.download != null ? 'COMPLETE' : phase === 'error' ? 'ERROR' : 'READY';
  const uploadStatus =
    phase === 'upload' ? 'TESTING' : results.upload != null ? 'COMPLETE' : phase === 'error' ? 'ERROR' : 'READY';

  const liveHeadline =
    phase === 'download' || phase === 'upload'
      ? `${phase === 'download' ? 'Download' : 'Upload'} at ${formatSpeed(liveValue)} Mbps`
      : phase === 'ping'
      ? `Latency ${formatLatency(liveValue)} ms`
      : phase === 'complete'
      ? `Final upload ${formatSpeed(results.upload)} Mbps`
      : 'Awaiting measurement';

  return (
    <main className="relative min-h-screen overflow-hidden bg-transparent px-6 py-12 text-white sm:px-10 md:px-12 lg:px-16">
      <div className="pointer-events-none absolute inset-0 -z-20 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.18),transparent_55%),radial-gradient(circle_at_bottom,rgba(167,139,250,0.22),transparent_60%),linear-gradient(145deg,rgba(8,25,61,0.95),rgba(2,6,23,0.98))]" />
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-60 mix-blend-screen [mask-image:radial-gradient(circle_at_center,black,transparent_75%)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_10%_20%,rgba(59,130,246,0.35),transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_80%,rgba(244,114,182,0.25),transparent_45%)]" />
      </div>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-12">
        <header className="flex flex-col gap-6 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            {/* <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-sky-500 to-fuchsia-500 text-2xl font-semibold shadow-[0_10px_40px_rgba(79,70,229,0.35)]">
              ZS
            </div> */}
            <div>
              <p className="text-xs uppercase tracking-[0.45em] text-slate-400">SpeedZone — Internet Speed Test</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Measure Ping, Download, and Upload in Real Time
              </h1>
            </div>
          </div>
          <div className="grid gap-3 text-sm text-slate-300 sm:grid-cols-2 sm:items-center">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(74,222,128,0.8)] animate-pulse" />
              <span className="uppercase tracking-[0.25em] text-slate-400">Public IP</span>
            </div>
            <div className="font-medium text-white">
              {networkInfo.loading ? 'Detecting...' : networkInfo.ip ?? 'Unavailable'}
            </div>
            <div className="uppercase tracking-[0.25em] text-slate-400">Provider</div>
            <div className="font-medium text-white">
              {networkInfo.loading
                ? 'Detecting...'
                : networkInfo.isp ?? networkInfo.org ?? 'Unavailable'}
            </div>
            <div className="uppercase tracking-[0.25em] text-slate-400">Location</div>
            <div className="font-medium text-white">
              {networkInfo.loading
                ? 'Detecting...'
                : formatLocation({
                    city: networkInfo.city,
                    region: networkInfo.region,
                    country: networkInfo.country,
                  })}
            </div>
            <div className="uppercase tracking-[0.25em] text-slate-400">Test Server</div>
            <div className="font-medium text-white flex flex-wrap items-center gap-3">
              <span className="leading-tight">
                {serverDisplay.city}, {serverDisplay.country} - {serverDisplay.provider}
              </span>
              <span
                className={[
                  'rounded-full border px-2 py-0.5 text-[0.65rem] uppercase tracking-[0.35em]',
                  remoteConfigured
                    ? 'border-emerald-400/40 text-emerald-200'
                    : 'border-amber-300/40 text-amber-200',
                ].join(' ')}
              >
                {remoteConfigured ? 'Remote Ready' : 'Local Fallback'}
              </span>
              <button
                type="button"
                onClick={() => setServerPickerOpen(true)}
                className="rounded-full border border-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-indigo-200 transition hover:border-indigo-300/60 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
              >
                Change
              </button>
            </div>
            {networkInfo.error ? (
              <div className="sm:col-span-2 text-xs uppercase tracking-[0.2em] text-amber-200/80">
                {networkInfo.error}
              </div>
            ) : null}
            {endpointInfo.error ? (
              <div className="sm:col-span-2 text-xs uppercase tracking-[0.2em] text-amber-200/80">
                {endpointInfo.error}
              </div>
            ) : null}
          </div>
        </header>

        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
          <div className="flex flex-col items-center gap-12">
            <SpeedGauge
              phase={phase}
              value={liveValue}
              unit={gaugeUnit}
              max={gaugeMax}
              status={statusLabel}
              detail={statusDetail}
              onStart={startTest}
              disabled={running}
              showButton={showGaugeButton}
              error={error}
            />

            <div className="grid w-full gap-4 sm:grid-cols-2">
              <MetricCard
                label="PING"
                accent="ping"
                value={formatLatency(results.ping)}
                unit="ms"
                status={pingStatus}
                progress={progress.ping}
                active={phase === 'ping'}
              />
              <MetricCard
                label="JITTER"
                accent="jitter"
                value={formatLatency(results.jitter)}
                unit="ms"
                status={jitterStatus}
                progress={progress.ping}
                active={phase === 'ping'}
              />
              <MetricCard
                label="DOWNLOAD"
                accent="download"
                value={formatSpeed(results.download)}
                unit="Mbps"
                status={downloadStatus}
                progress={progress.download}
                active={phase === 'download'}
              />
              <MetricCard
                label="UPLOAD"
                accent="upload"
                value={formatSpeed(results.upload)}
                unit="Mbps"
                status={uploadStatus}
                progress={progress.upload}
                active={phase === 'upload' || phase === 'complete'}
              />
            </div>
          </div>

          <aside className="space-y-6">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.4em] text-slate-400">
                <span>Test Info</span>
                <span>{phase === 'complete' ? 'Done' : running ? 'Running' : 'Idle'}</span>
              </div>
              <dl className="mt-6 space-y-4 text-sm text-slate-300">
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">Public IP</dt>
                  <dd className="text-right font-medium text-white">
                    {networkInfo.loading ? 'Detecting...' : networkInfo.ip ?? 'Unavailable'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">ISP</dt>
                  <dd className="text-right">
                    {networkInfo.loading
                      ? 'Detecting...'
                      : networkInfo.isp ?? networkInfo.org ?? 'Unavailable'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">Location</dt>
                  <dd className="text-right">
                    {networkInfo.loading
                      ? 'Detecting...'
                      : formatLocation({
                          city: networkInfo.city,
                          region: networkInfo.region,
                          country: networkInfo.country,
                        })}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">Server</dt>
                  <dd className="text-right">
                    {serverDisplay.city}, {serverDisplay.country}
                  </dd>
                </div>
                {endpointInfo.colo ? (
                  <div className="flex justify-between gap-4">
                    <dt className="uppercase tracking-[0.3em] text-slate-500">Peer Colo</dt>
                    <dd className="text-right">{endpointInfo.colo}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">Host</dt>
                  <dd className="text-right">{hostLabel}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">Connection</dt>
                  <dd className="text-right">Multi-thread</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="uppercase tracking-[0.3em] text-slate-500">Duration</dt>
                  <dd className="text-right">{testDuration}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-3xl border border-indigo-400/20 bg-indigo-500/10 p-6 shadow-[0_35px_120px_-60px_rgba(79,70,229,0.7)] backdrop-blur">
              <p className="text-xs uppercase tracking-[0.4em] text-indigo-200">Live Readout</p>
              <p className="mt-4 text-sm leading-6 text-indigo-100/90">{liveHeadline}</p>
              <p className="mt-3 text-xs uppercase tracking-[0.3em] text-indigo-200/70">
                Tap GO again to rerun the benchmark.
              </p>
            </div>
          </aside>
        </div>

        <section
          aria-labelledby="how-it-works-heading"
          className="rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur"
        >
          <h2
            id="how-it-works-heading"
            className="text-2xl font-semibold tracking-tight text-white sm:text-3xl"
          >
            How the SpeedZone internet speed test works
          </h2>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">
            SpeedZone is a free, ad-free internet speed test that runs directly in your
            browser — no app or sign-up required. Press <strong>Go</strong> and SpeedZone measures
            your connection in three stages, giving you an accurate real-world picture of your
            broadband, Wi-Fi, or mobile network performance.
          </p>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-200">
                1. Ping &amp; Jitter
              </h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                We send repeated lightweight requests to find your latency (ping) and how stable it
                is (jitter) — the numbers that matter most for gaming and video calls.
              </p>
            </li>
            <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-200">
                2. Download
              </h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Multiple parallel connections stream data from nearby test servers to measure how
                fast you can receive data, in megabits per second (Mbps).
              </p>
            </li>
            <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-indigo-200">
                3. Upload
              </h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                We push data upstream over several threads to measure your upload capacity —
                important for video calls, cloud backups, and live streaming.
              </p>
            </li>
          </ol>
        </section>

        <section
          aria-labelledby="why-heading"
          className="rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur"
        >
          <h2
            id="why-heading"
            className="text-2xl font-semibold tracking-tight text-white sm:text-3xl"
          >
            Why choose SpeedZone
          </h2>
          <ul className="mt-6 grid gap-3 text-sm leading-6 text-slate-300 sm:grid-cols-2">
            <li>✓ 100% free with no ads and no sign-up</li>
            <li>✓ Accurate multi-threaded download &amp; upload measurement</li>
            <li>✓ Real ping and jitter, not just bandwidth</li>
            <li>✓ Detects your public IP, ISP and location automatically</li>
            <li>✓ Choose the test server closest to you</li>
            <li>✓ Fast, modern interface that works on any device</li>
          </ul>
        </section>

        <section
          aria-labelledby="faq-heading"
          className="rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur"
        >
          <h2
            id="faq-heading"
            className="text-2xl font-semibold tracking-tight text-white sm:text-3xl"
          >
            Frequently asked questions
          </h2>
          <div className="mt-6 space-y-5">
            <details className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <summary className="cursor-pointer text-base font-medium text-white">
                How does SpeedZone measure my internet speed?
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                SpeedZone runs the test directly in your browser. It first measures ping and jitter
                with repeated lightweight requests, then measures download and upload throughput
                using multiple parallel connections to nearby Cloudflare test endpoints, giving an
                accurate picture of your real-world connection speed.
              </p>
            </details>
            <details className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <summary className="cursor-pointer text-base font-medium text-white">
                Is SpeedZone free to use?
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Yes. SpeedZone is completely free, requires no sign-up, and has no ads. Just open the
                page and press Go.
              </p>
            </details>
            <details className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <summary className="cursor-pointer text-base font-medium text-white">
                What is a good internet speed?
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                For HD streaming and browsing, 25 Mbps download is comfortable. For 4K streaming,
                video calls and multiple devices, 100 Mbps or more is recommended. Lower ping (under
                30 ms) and low jitter matter most for gaming and video calls.
              </p>
            </details>
            <details className="group rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <summary className="cursor-pointer text-base font-medium text-white">
                What is the difference between ping, download and upload?
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                Ping (latency) is how quickly your connection responds, measured in milliseconds.
                Download speed is how fast you receive data. Upload speed is how fast you send data.
                All three are measured in a single SpeedZone test.
              </p>
            </details>
          </div>
        </section>

        <footer className="pb-4 text-center text-xs uppercase tracking-[0.3em] text-slate-500">
          SpeedZone — free internet speed test · ping, download &amp; upload
        </footer>
      </div>
      {isServerPickerOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur"
          onClick={() => setServerPickerOpen(false)}
        >
          <div
            className="relative mx-4 w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-900/95 p-6 shadow-[0_40px_120px_-60px_rgba(99,102,241,0.6)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Choose Test Server</h2>
                <p className="mt-1 text-xs uppercase tracking-[0.3em] text-slate-400">
                  Configure real endpoints you operate before running tests
                </p>
              </div>
              <button
                type="button"
                onClick={() => setServerPickerOpen(false)}
                className="rounded-full border border-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-slate-300 transition hover:border-slate-200/60 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-400/60"
              >
                Close
              </button>
            </div>
            <div className="mt-5 max-h-80 space-y-3 overflow-y-auto pr-1">
              {SERVER_POOL.map((option) => {
                const isSelected = option.id === selectedServer.id;
                const remoteConfigured =
                  Boolean(option.downloadUrl?.trim() && option.uploadUrl?.trim());
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleServerSelect(option.id)}
                    className={[
                      'w-full rounded-2xl border px-4 py-4 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400/60',
                      isSelected
                        ? 'border-indigo-400/70 bg-indigo-500/15 text-white shadow-[0_12px_50px_-30px_rgba(99,102,241,0.9)]'
                        : 'border-white/10 bg-white/[0.04] text-slate-200 hover:border-indigo-300/40 hover:bg-white/[0.08]',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-white">
                          {option.city}, {option.country}
                        </div>
                        <div className="mt-1 text-xs uppercase tracking-[0.35em] text-slate-400">
                          {option.provider}
                        </div>
                      </div>
                      <div className="text-right text-xs uppercase tracking-[0.25em]">
                        <span
                          className={
                            remoteConfigured
                              ? 'text-emerald-300'
                              : 'text-amber-200'
                          }
                        >
                          {remoteConfigured ? 'Remote Ready' : 'Local Fallback'}
                        </span>
                      </div>
                    </div>
                    {option.id === 'cloudflare-auto' ? (
                      <p className="mt-2 text-[0.7rem] leading-5 text-indigo-200/90">
                        Uses Cloudflare&apos;s public test endpoints. Metrics depend on the
                        closest Cloudflare PoP reachable from the browser.
                      </p>
                    ) : null}
                    {!remoteConfigured ? (
                      <p className="mt-2 text-[0.7rem] leading-5 text-amber-100/80">
                        Provide custom upload/download URLs for this server via code or env
                        vars before expecting real measurements.
                      </p>
                    ) : null}
                    {isSelected ? (
                      <div className="mt-3 text-[0.65rem] uppercase tracking-[0.3em] text-indigo-200">
                        Selected
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
