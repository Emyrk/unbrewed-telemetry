import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

const assetRoutes: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'dashboard.html', contentType: 'text/html; charset=utf-8' },
  '/dashboard': { file: 'dashboard.html', contentType: 'text/html; charset=utf-8' },
  '/dashboard/': { file: 'dashboard.html', contentType: 'text/html; charset=utf-8' },
  '/admin': { file: 'admin.html', contentType: 'text/html; charset=utf-8' },
  '/admin/': { file: 'admin.html', contentType: 'text/html; charset=utf-8' },
  // Public "Road to Expert+" journey page (#248) — no auth, experiment data only.
  '/road-to-expert': { file: 'road-to-expert.html', contentType: 'text/html; charset=utf-8' },
  '/road-to-expert/': { file: 'road-to-expert.html', contentType: 'text/html; charset=utf-8' },
  '/favicon.ico': { file: 'favicon.ico', contentType: 'image/x-icon' },
  '/assets/dashboard.css': { file: 'assets/dashboard.css', contentType: 'text/css; charset=utf-8' },
  '/assets/dashboard.js': { file: 'assets/dashboard.js', contentType: 'text/javascript; charset=utf-8' },
};

export async function serveDashboardAsset(pathname: string, res: ServerResponse): Promise<boolean> {
  const route = assetRoutes[pathname];
  if (!route) return false;
  const body = await readFile(join(publicDir, route.file));
  res.writeHead(200, {
    'content-type': route.contentType,
    'content-length': body.length,
    'cache-control': route.file === 'dashboard.html' ? 'no-store' : 'public, max-age=60',
  });
  res.end(body);
  return true;
}
