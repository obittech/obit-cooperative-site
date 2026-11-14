const DAY = 86400000;
const BASE = 'No matching identity record was returned. Your application is still awaiting verification.';

// Display only: reservation, consent, spending and identity rules stay authoritative.
export function notFoundMessage(startedMs, now = Date.now()) {
  const started = Number(startedMs);
  if (startedMs == null || !Number.isSafeInteger(started) || started <= 0
      || !Number.isSafeInteger(started + DAY) || started + DAY > 8640000000000000) {
    return `${BASE} Contact support to check the previous request before retrying.`;
  }
  const until = started + DAY;
  // Match the existing inclusive started_ms >= now - DAY duplicate guard.
  if (now <= until) {
    return `${BASE} The 24-hour waiting period for this product ends after ${new Date(until).toISOString()} (UTC). Contact support to check your details before another attempt.`;
  }
  return `${BASE} The 24-hour waiting period for the previous request has ended. Contact support to check your details before another attempt. Other verification limits still apply.`;
}
