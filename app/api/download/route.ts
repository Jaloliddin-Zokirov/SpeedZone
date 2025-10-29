import { NextRequest } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TOTAL_BYTES = 5 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MIN_CHUNK_SIZE = 16 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;

function clampChunkSize(size: number | null) {
  if (!size || !Number.isFinite(size)) return DEFAULT_CHUNK_SIZE;
  return Math.min(Math.max(Math.floor(size), MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
}

function parsePositiveInt(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function makeFixedStream(totalBytes: number, chunkSize: number) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const remaining = totalBytes - sent;
      const size = Math.min(chunkSize, remaining);
      controller.enqueue(crypto.randomBytes(size));
      sent += size;
    },
  });
}

function makeContinuousStream(chunkSize: number) {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cancelled) {
        controller.close();
        return;
      }
      controller.enqueue(crypto.randomBytes(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawBytes = searchParams.get('bytes');
  const chunkSize = clampChunkSize(parsePositiveInt(searchParams.get('chunk')));
  let totalBytes: number | null = null;

  if (rawBytes == null) {
    totalBytes = DEFAULT_TOTAL_BYTES;
  } else {
    const parsedBytes = parsePositiveInt(rawBytes);
    if (parsedBytes) {
      totalBytes = parsedBytes;
    } else if (rawBytes === '0') {
      totalBytes = null;
    } else {
      totalBytes = DEFAULT_TOTAL_BYTES;
    }
  }

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  });

  const stream =
    totalBytes != null ? makeFixedStream(totalBytes, chunkSize) : makeContinuousStream(chunkSize);

  if (totalBytes != null) {
    headers.set('Content-Length', String(totalBytes));
  }

  return new Response(stream, { headers });
}
