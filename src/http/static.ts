import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

const assetRoutes: Record<string, { file: string; contentType: string }> = {
  // Redesigned landing page (#98); the old balance dashboard moved to /legacy, unchanged.
  '/': { file: 'home.html', contentType: 'text/html; charset=utf-8' },
  '/legacy': { file: 'dashboard.html', contentType: 'text/html; charset=utf-8' },
  '/legacy/': { file: 'dashboard.html', contentType: 'text/html; charset=utf-8' },
  '/fleet': { file: 'fleet.html', contentType: 'text/html; charset=utf-8' },
  '/fleet/': { file: 'fleet.html', contentType: 'text/html; charset=utf-8' },
  '/admin': { file: 'admin.html', contentType: 'text/html; charset=utf-8' },
  '/admin/': { file: 'admin.html', contentType: 'text/html; charset=utf-8' },
  // Public "Road to Expert+" journey page (#248) — no auth, experiment data only.
  '/road-to-expert': { file: 'road-to-expert.html', contentType: 'text/html; charset=utf-8' },
  '/road-to-expert/': { file: 'road-to-expert.html', contentType: 'text/html; charset=utf-8' },
  '/favicon.ico': { file: 'favicon.ico', contentType: 'image/x-icon' },
  '/assets/dashboard.css': { file: 'assets/dashboard.css', contentType: 'text/css; charset=utf-8' },
  '/assets/dashboard.js': { file: 'assets/dashboard.js', contentType: 'text/javascript; charset=utf-8' },
  '/assets/home.css': { file: 'assets/home.css', contentType: 'text/css; charset=utf-8' },
  '/assets/home.js': { file: 'assets/home.js', contentType: 'text/javascript; charset=utf-8' },
};

/** Old addresses of moved pages. The query string is kept so deep links (`?deck=…&tab=…`) still land. */
const redirects: Record<string, string> = {
  '/dashboard': '/legacy',
  '/dashboard/': '/legacy',
};

const noStoreFiles = new Set(['dashboard.html', 'home.html']);

export function serveStaticRedirect(url: URL, res: ServerResponse): boolean {
  const target = redirects[url.pathname];
  if (!target) return false;
  res.writeHead(302, { location: `${target}${url.search}`, 'cache-control': 'no-store' });
  res.end();
  return true;
}

export async function serveDashboardAsset(pathname: string, res: ServerResponse): Promise<boolean> {
  const route = assetRoutes[pathname];
  if (!route) return false;
  const body = await readFile(join(publicDir, route.file));
  res.writeHead(200, {
    'content-type': route.contentType,
    'content-length': body.length,
    'cache-control': noStoreFiles.has(route.file) ? 'no-store' : 'public, max-age=60',
  });
  res.end(body);
  return true;
}
