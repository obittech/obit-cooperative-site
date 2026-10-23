// Public readiness probe: no credentials, configuration, or database errors exposed.
export function createHealthHandler(query, timeoutMs = 2000) {
  return async (_req, res) => {
    let timer;
    try {
      const row = await Promise.race([
        Promise.resolve().then(query),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Database probe timed out')), timeoutMs);
        }),
      ]);
      const ok = Number(row?.ok) === 1;
      res.json(ok ? 200 : 503, { ok, service: 'obit-cooperative-api', time: new Date().toISOString() });
    } catch {
      res.json(503, { ok: false, service: 'obit-cooperative-api', time: new Date().toISOString() });
    } finally {
      clearTimeout(timer);
    }
  };
}
