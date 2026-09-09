import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

export function publicCachePolicy(relative) {
  const key = relative.split(path.sep).join('/');
  if (/^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(key)
      || /^fonts\/web\/[^/]+\.[a-f0-9]{16}\.woff2$/.test(key)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=0, must-revalidate';
}

// Only invoke for dist/client, never for authenticated project/image routes.
export function servePublicStatic(request, response, file, clientDir, types) {
  const stat = statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const headers = {
    'content-type': path.extname(file) === '.woff2' ? 'font/woff2' : types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': publicCachePolicy(path.relative(clientDir, file)),
    etag,
    'last-modified': stat.mtime.toUTCString(),
  };
  if (request.headers['if-none-match']?.split(',').map(s => s.trim()).some(s => s === etag || s === '*')) {
    response.writeHead(304, headers);
    return response.end();
  }
  response.writeHead(200, { ...headers, 'content-length': stat.size });
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(file);
  stream.on('error', error => response.destroy(error));
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
