// En Vercel usamos puppeteer-core + @sparticuz/chromium (Chromium liviano
// que entra en el límite de tamaño de una función serverless). En local no
// hace falta ese Chromium recortado: usamos el `puppeteer` completo, que ya
// trae su propio binario descargado por npm install.
//
// Los tres paquetes son ESM-only ("type": "module") — Next.js los rompe si
// intenta bundlearlos vía require() en una ruta compilada a CJS, así que se
// cargan con import() dinámico, que sí sabe resolver ESM desde cualquier lado.
async function launchBrowser() {
  if (process.env.VERCEL) {
    const chromium = (await import('@sparticuz/chromium')).default;
    const puppeteer = (await import('puppeteer-core')).default;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  const puppeteer = (await import('puppeteer')).default;
  return puppeteer.launch({ headless: true });
}

async function renderPdf(url, cookie) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    if (cookie) await page.setExtraHTTPHeaders({ Cookie: cookie });
    await page.goto(url, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'letter', printBackground: true });
  } finally {
    await browser.close();
  }
}

module.exports = { renderPdf };
