import {monnifyReadiness} from '../src/services/market-monnify-readiness.js';
import {checkMonnifyAuthentication} from '../src/services/market-monnify.js';
import {checkoutConfig} from '../src/services/market-payment-state.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--authenticate') || args.length > 1) {
 console.error('Usage: npm run check:monnify -- [--authenticate]');
 process.exitCode = 2;
} else {
 const report = monnifyReadiness();
 if (args.includes('--authenticate') && report.sandbox_configured) {
  try {
   await checkMonnifyAuthentication(checkoutConfig());
   report.provider_credentials_verified = true;
  } catch {
   // Provider error bodies can contain financial or authentication data.
   report.authentication_error = 'Sandbox authentication was not confirmed. Check credentials and provider connectivity.';
  }
 }
 console.log(JSON.stringify(report, null, 2));
 console.log('No checkout, payment, refund, settlement or account change was initiated.');
 if (!report.sandbox_configured || (args.includes('--authenticate') && !report.provider_credentials_verified)) process.exitCode = 1;
}
