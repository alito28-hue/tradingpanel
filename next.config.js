/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['puppeteer', 'puppeteer-core', '@sparticuz/chromium'],
  outputFileTracingIncludes: {
    '/api/bitacora/export-pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
    '/api/playbook/export-pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
};

module.exports = nextConfig;
