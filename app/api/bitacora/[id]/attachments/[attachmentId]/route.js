import { query } from '../../../../../../lib/db';
import { deleteAttachment } from '../../../../../../lib/blob';

export async function DELETE(_req, { params }) {
  try {
    const { attachmentId } = await params;
    const { rows } = await query('SELECT url FROM bitacora_attachments WHERE id = $1', [attachmentId]);
    if (!rows.length) return Response.json({ error: 'No encontrada' }, { status: 404 });
    await deleteAttachment(rows[0].url).catch(() => {});
    await query('DELETE FROM bitacora_attachments WHERE id = $1', [attachmentId]);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
