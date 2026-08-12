import { renderPdf } from '../../../../lib/pdf';

export const maxDuration = 60;

export async function GET(req) {
  try {
    const { origin } = new URL(req.url);
    const cookie = req.headers.get('cookie') || '';
    const printUrl = `${origin}/playbook/estrategia-btc-playbook.html`;
    const pdf = await renderPdf(printUrl, cookie);

    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="playbook_btc.pdf"',
      },
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
