import { X509Certificate, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import type { AppConfig } from './config.js';

/** Each slot has its own process, cookie jar and network activity. */
export async function launchSlotBrowser(config: AppConfig): Promise<Browser> {
  const args: string[] = [];
  // Managed Cloud uses an explicitly configured TLS inspection CA. Pin exactly
  // that CA's public key; ordinary Mac runs use Chrome's normal certificate trust.
  if (process.env.TAKACHIHO_PROXY_CA) {
    const cert = new X509Certificate(await readFile(process.env.TAKACHIHO_PROXY_CA));
    const pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    args.push(`--ignore-certificate-errors-spki-list=${pin}`);
  }
  const executablePath = config.browser.executablePath ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const proxy = process.env.TAKACHIHO_PROXY;
  return chromium.launch({
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    headless: config.browser.headless,
    ...(executablePath ? { executablePath } : config.browser.channel === 'chrome' ? { channel: 'chrome' } : {}),
    ...(proxy ? { proxy: { server: proxy } } : {}),
    args,
  });
}
