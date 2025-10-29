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
    downloadUrl: process.env.NEXT_PUBLIC_ZSPEED_DOWNLOAD_URL ?? DEFAULT_REMOTE_DOWNLOAD_URL,
    uploadUrl: process.env.NEXT_PUBLIC_ZSPEED_UPLOAD_URL ?? DEFAULT_REMOTE_UPLOAD_URL,
    downloadBytes:
      Number(process.env.NEXT_PUBLIC_ZSPEED_DOWNLOAD_BYTES ?? DEFAULT_REMOTE_DOWNLOAD_BYTES) ||
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

async function openDownloadStream(
  signal: AbortSignal,
  chunkSize: number,
  remoteUrl: string | null | undefined,
  remoteBytes: number
) {
  const cacheBust = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const remoteTarget = remoteUrl?.trim().length ? remoteUrl.trim() : null;

  if (remoteTarget) {
    try {
      const inbound = new URL(remoteTarget);
      inbound.searchParams.set('bytes', String(remoteBytes));
      inbound.searchParams.set('cacheBust', cacheBust);
      const remoteResponse = await fetch(inbound.toString(), { signal, cache: 'no-store' });
      if (remoteResponse.ok && remoteResponse.body) {
        return remoteResponse;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      console.warn('External download endpoint failed, falling back to local stream.', err);
    }
  }

  const fallbackUrl = `/api/download?bytes=0&chunk=${chunkSize}&cacheBust=${cacheBust}`;
  const fallbackResponse = await fetch(fallbackUrl, { signal, cache: 'no-store' });
  if (!fallbackResponse.ok) {
    throw new Error(`Download failed with status ${fallbackResponse.status}`);
  }
  if (!fallbackResponse.body) {
    throw new Error('Download stream unavailable');
  }
  return fallbackResponse;
}

async function measureDownload({
  durationMs = 17_000,
  concurrency = 4,
  chunkSize = 256 * 1024,
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
  const safeChunkSize = Math.min(
    Math.max(Math.floor(chunkSize ?? 0) || 256 * 1024, 16 * 1024),
    1 * 1024 * 1024
  );
  const controllers = new Set<AbortController>();
  const start = performance.now();
  const stopTime = start + duration;
  let stop = false;
  let totalBytes = 0;

  const timer = window.setTimeout(() => {
    stop = true;
    const snapshot = Array.from(controllers);
    snapshot.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        /* noop */
      }
    });
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

  async function runWorker() {
    if (stop) return;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const res = await openDownloadStream(controller.signal, safeChunkSize, remoteUrl, remoteBytes);
      const stream = res.body;
      if (!stream) {
        throw new Error('Download stream unavailable');
      }
      const reader = stream.getReader();
      try {
        while (!stop) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            emitProgress();
            if (!stop && performance.now() >= stopTime) {
              stop = true;
              const snapshot = Array.from(controllers);
              snapshot.forEach((ctrl) => {
                if (ctrl !== controller) {
                  try {
                    ctrl.abort();
                  } catch {
                    /* noop */
                  }
                }
              });
              await reader.cancel().catch(() => controller.abort());
              break;
            }
          }
        }
      } finally {
        reader.releaseLock?.();
      }
    } catch (err) {
      const abortError = err instanceof DOMException && err.name === 'AbortError';
      if (!abortError && !stop) {
        stop = true;
        const snapshot = Array.from(controllers);
        snapshot.forEach((ctrl) => {
          try {
            ctrl.abort();
          } catch {
            /* noop */
          }
        });
        throw err;
      }
    } finally {
      controllers.delete(controller);
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  } finally {
    window.clearTimeout(timer);
    const snapshot = Array.from(controllers);
    snapshot.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        /* noop */
      }
    });
    controllers.clear();
  }

  const elapsedMs = Math.max(performance.now() - start, duration);
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
  const remoteEndpoint = remoteUrl?.trim().length ? remoteUrl.trim() : null;
  let preferRemoteUpload = Boolean(remoteEndpoint);

  const timer = window.setTimeout(() => {
    stop = true;
    const snapshot = Array.from(uploads);
    snapshot.forEach((xhr) => {
      try {
        xhr.abort();
      } catch {
        /* noop */
      }
    });
  }, duration);

  function emitProgress() {
    const now = performance.now();
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
    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  } finally {
    window.clearTimeout(timer);
    const snapshot = Array.from(uploads);
    snapshot.forEach((xhr) => {
      try {
        xhr.abort();
      } catch {
        /* noop */
      }
    });
    uploads.clear();
  }

  const elapsedMs = Math.max(performance.now() - start, duration);
  const seconds = elapsedMs / 1000;
  const mbps = seconds > 0 ? (totalUploaded * 8) / 1_000_000 / seconds : 0;
  onProgress?.(mbps, 1);
  return { mbps, bytes: totalUploaded, seconds };
}

function MetricCard({
  label,
  value,
  unit,
  status,
  progress,
  active,
}: {
  label: string;
  value: string;
  unit: string;
  status: string;
  progress?: number;
  active?: boolean;
}) {
  const showProgress = progress != null && progress < 0.995;
  return (
    <div
      className={[
        'relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_24px_70px_-55px_rgba(15,23,42,0.9)] transition-shadow duration-300',
        active ? 'border-indigo-400/60 shadow-[0_12px_70px_-30px_rgba(99,102,241,0.9)]' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.35em] text-slate-400">{label}</span>
        <span className="text-[0.65rem] uppercase tracking-[0.25em] text-slate-500">{status}</span>
      </div>
      <div className="mt-4 flex items-end gap-2">
        <span className="text-3xl font-semibold text-white">{value}</span>
        <span className="pb-1 text-sm text-slate-400">{unit}</span>
      </div>
      {showProgress ? (
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-800/70">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-sky-500 to-fuchsia-500 transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(progress ?? 0, 0.04) * 100}%` }}
          />
        </div>
      ) : null}
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
  const angle = -135 + ratio * 270;
  const buttonLabel = phase === 'complete' ? 'Go Again' : phase === 'error' ? 'Retry' : 'Go';

  return (
    <div className="relative flex w-full flex-col items-center">
      <div className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-[radial-gradient(circle_at_50%_20%,rgba(129,140,248,0.25),transparent_65%)]" />
      <div className="relative aspect-square w-full max-w-[24rem]">
        <div className="absolute inset-0 rounded-full border border-white/10 bg-gradient-to-br from-slate-900 via-slate-950 to-black shadow-[0_0_120px_rgba(79,70,229,0.35)]" />
        <div
          className="absolute inset-[12%] rounded-full border border-white/5"
          style={{
            background: `conic-gradient(from 225deg, rgba(99,102,241,0.85) ${ratio * 100}%, rgba(100,116,139,0.14) ${ratio * 100}% 100%)`,
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
              <span className="text-xs uppercase tracking-[0.35em] text-slate-500">ZSpeed</span>
            </button>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <span className="text-6xl font-semibold tracking-tight text-white drop-shadow-sm">
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
        setEndpointInfo((prev) => ({
          ...prev,
          host: selectedHost,
          colo: data.colo ?? null,
          city: data.city ?? null,
          region: data.region ?? null,
          country: data.country ?? null,
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
      const download = await measureDownload({
        durationMs: 17_000,
        concurrency: 4,
        chunkSize: 256 * 1024,
        remoteUrl: selectedDownloadUrl,
        remoteBytes: selectedDownloadBytes,
        onProgress: (mbps, fraction) => {
          if (runRef.current !== runId) return;
          setLiveValue(mbps);
          setSpeedScale((prev) => adjustSpeedScale(prev, mbps));
          setProgress((prev) => ({ ...prev, download: fraction }));
        },
      });
      if (runRef.current !== runId) return;
      setResults((prev) => ({ ...prev, download: download.mbps }));
      setProgress((prev) => ({ ...prev, download: 1 }));
      setLiveValue(download.mbps);

      setPhase('upload');
      const upload = await measureUpload({
        durationMs: 17_000,
        concurrency: 3,
        payloadBytes: 512 * 1024,
        remoteUrl: selectedUploadUrl,
        onProgress: (mbps, fraction) => {
          if (runRef.current !== runId) return;
          setLiveValue(mbps);
          setSpeedScale((prev) => adjustSpeedScale(prev, mbps));
          setProgress((prev) => ({ ...prev, upload: fraction }));
        },
      });
      if (runRef.current !== runId) return;
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
              <p className="text-xs uppercase tracking-[0.45em] text-slate-400">ZSpeed — Internet Speed Test</p>
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
                value={formatLatency(results.ping)}
                unit="ms"
                status={pingStatus}
                progress={progress.ping}
                active={phase === 'ping'}
              />
              <MetricCard
                label="JITTER"
                value={formatLatency(results.jitter)}
                unit="ms"
                status={jitterStatus}
                progress={progress.ping}
                active={phase === 'ping'}
              />
              <MetricCard
                label="DOWNLOAD"
                value={formatSpeed(results.download)}
                unit="Mbps"
                status={downloadStatus}
                progress={progress.download}
                active={phase === 'download'}
              />
              <MetricCard
                label="UPLOAD"
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
