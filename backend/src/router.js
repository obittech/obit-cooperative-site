// router.js — deliberately tiny replacement for Express so this scaffold
// runs with zero `npm install`. If your team prefers Express/Fastify,
// the route handlers in src/routes/*.js are plain (req, res, params) =>
// functions and port over almost unchanged.

export class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, keys: string[], handlers: fn[] }
  }

  _register(method, path, handlers) {
    const keys = [];
    const pattern = new RegExp(
      '^' +
        path
          .split('/')
          .map((segment) => {
            if (segment.startsWith(':')) {
              keys.push(segment.slice(1));
              return '([^/]+)';
            }
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$'
    );
    this.routes.push({ method, pattern, keys, handlers });
  }

  get(path, ...handlers) { this._register('GET', path, handlers); }
  post(path, ...handlers) { this._register('POST', path, handlers); }
  patch(path, ...handlers) { this._register('PATCH', path, handlers); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { handlers: route.handlers, params };
    }
    return null;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sandbox-signature',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  });
  res.end(payload);
}

// Webhook routes must verify an HMAC signature over the *raw* body, so they
// read raw text themselves rather than going through readJsonBody.
export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const LIMIT = 1_000_000;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMIT) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const LIMIT = 1_000_000; // 1MB guard against oversized payloads
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
