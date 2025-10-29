export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
