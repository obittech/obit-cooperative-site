// Offline diagnostics only. Never return credentials or contact the provider.
export function monnifyReadiness(env = process.env) {
 let callbackValid = false;
 try {
  const u = new URL(env.MARKET_MONNIFY_CALLBACK_URL || '');
  callbackValid = !u.username && !u.password && !u.search && u.pathname.endsWith('/market-account.html') &&
   (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', 'terminal.local'].includes(u.hostname)));
 } catch {}
 const checks = {
  isolated_environment: ['test', 'development'].includes(env.NODE_ENV),
  sandbox_mode: env.MARKET_CHECKOUT_MODE === 'test',
  sandbox_api_key: String(env.MARKET_MONNIFY_API_KEY || '').startsWith('MK_TEST_'),
  secret_key: String(env.MARKET_MONNIFY_SECRET_KEY || '').length >= 10,
  contract_code: /^\d{6,30}$/.test(String(env.MARKET_MONNIFY_CONTRACT_CODE || '')),
  callback_url: callbackValid
 };
 return {
  provider: 'monnify',
  sandbox_configured: Object.values(checks).every(Boolean),
  live_collection_available: false,
  checks,
  missing_or_invalid: Object.keys(checks).filter(key => !checks[key]),
  webhook_path: '/api/webhooks/market/monnify',
  unsigned_sandbox_notifications: env.MARKET_MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOK === 'true',
  provider_credentials_verified: false,
  real_sandbox_payment_verified: false
 };
}
