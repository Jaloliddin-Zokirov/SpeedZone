import { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
  const reader = req.body?.getReader();
  let received = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) received += value.byteLength;
    }
  } else {
    const buf = await req.arrayBuffer();
    received = buf.byteLength;
  }
  return Response.json({ ok: true, bytesReceived: received }, { headers: { 'Cache-Control': 'no-store' } });
}