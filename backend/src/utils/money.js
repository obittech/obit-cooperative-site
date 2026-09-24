// Exact NGN parser for money-moving routes. Avoids binary floating-point rounding.
export function parseNgnToKobo(value, { minKobo = 1, maxKobo = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('INVALID_MONEY');
  const [whole, fraction = ''] = raw.split('.');
  const kobo = Number(BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)));
  if (!Number.isSafeInteger(kobo) || kobo < minKobo || kobo > maxKobo) throw new Error('INVALID_MONEY');
  return kobo;
}

export function koboToNgn(kobo) {
  return Number(kobo) / 100;
}
