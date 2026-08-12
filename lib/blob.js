const { put, del } = require('@vercel/blob');

async function uploadAttachment(entryId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = await put(`bitacora/${entryId}/${Date.now()}-${safeName}`, file, {
    access: 'public',
    addRandomSuffix: true,
  });
  return blob.url;
}

async function deleteAttachment(url) {
  await del(url);
}

module.exports = { uploadAttachment, deleteAttachment };
