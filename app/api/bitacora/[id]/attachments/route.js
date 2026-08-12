import { query } from '../../../../../lib/db';
import { uploadAttachment } from '../../../../../lib/blob';

export async function POST(req, { params }) {
  try {
    const { id } = await params;
    const form = await req.formData();
    const files = form.getAll('files');
    if (!files.length) return Response.json({ error: 'No se recibieron archivos' }, { status: 400 });

    const attachments = [];
    for (const file of files) {
      const url = await uploadAttachment(id, file);
      const { rows } = await query(
        'INSERT INTO bitacora_attachments (entry_id, url) VALUES ($1,$2) RETURNING id, url, caption',
        [id, url]
      );
      attachments.push(rows[0]);
    }
    return Response.json({ ok: true, attachments });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
