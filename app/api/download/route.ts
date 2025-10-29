import { NextRequest } from 'next/server';
import crypto from 'crypto';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function toInt(v: string | null, def = 5 * 1024 * 1024) {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function randomChunk(size: number) {
  return crypto.randomBytes(size);
}
function streamRandomBytes(totalBytes: number, chunkSize = 64 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) { controller.close(); return; }
      const remaining = totalBytes - sent;
      const size = Math.min(chunkSize, remaining);
      const chunk = randomChunk(size);
      sent += size;
      controller.enqueue(chunk);
    },
  });
}
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const bytes = toInt(searchParams.get('bytes'));
  const stream = streamRandomBytes(bytes);
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes),
      'Cache-Control': 'no-store',
    },
  });
}