import { renderPdf } from '../../../../lib/pdf';

export const maxDuration = 60;

export async function GET(req) {
  try {
    const { searchParams, origin } = new URL(req.url);
    const from = searchParams.get('from') || '';
    const to = searchParams.get('to') || '';
    const cookie = req.headers.get('cookie') || '';

    const printUrl = `${origin}/bitacora/print?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const pdf = await renderPdf(printUrl, cookie);

    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="bitacora_${from || 'inicio'}_a_${to || 'hoy'}.pdf"`,
      },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
