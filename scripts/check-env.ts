/**
 * Reports configuration readiness WITHOUT ever printing a value: each key is shown as "set" or "missing".
 * Exit code 0 when the required PayPal sandbox settings are present, 1 otherwise.
 */
import { loadDotEnv } from '../src/config/env.js';

loadDotEnv();
const env = process.env;
const REQUIRED = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] as const;
const OPTIONAL = ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'PUBLIC_BASE_URL', 'SPIKE_PORT', 'SPIKE_RETURN_BASE', 'DB_PATH', 'HOST', 'PORT', 'SHOP_PORT', 'SHOP_URL', 'GUARD_URL', 'AGENT_ID'] as const;

let ready = true;
const isSet = (key: string): boolean => (env[key] ?? '').trim() !== '';

if (env.PAYPAL_ENV === 'SANDBOX') {
  console.log('PAYPAL_ENV=SANDBOX');
} else {
  ready = false;
  console.log(`PAYPAL_ENV=${isSet('PAYPAL_ENV') ? 'invalid' : 'missing'} (must be exactly SANDBOX)`);
}
for (const key of REQUIRED) {
  if (!isSet(key)) ready = false;
  console.log(`${key}=${isSet(key) ? 'set' : 'missing'}`);
}
for (const key of OPTIONAL) console.log(`${key}=${isSet(key) ? 'set' : 'missing'}`);

console.log(ready ? 'READY: required PayPal sandbox settings are present.' : 'NOT READY: copy .env.example to .env and fill in the missing values.');
process.exitCode = ready ? 0 : 1;
