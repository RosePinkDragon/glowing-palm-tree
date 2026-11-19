import { handleHook, msg91Client, type Send } from './hook.ts';

// All values are Supabase Edge Function secrets, never committed. See docs/RELEASE.md.
const secret = Deno.env.get('SEND_SMS_HOOK_SECRET') ?? '';
const authKey = Deno.env.get('MSG91_AUTH_KEY') ?? '';
const integratedNumber = Deno.env.get('MSG91_WHATSAPP_NUMBER') ?? '';
const templateName = Deno.env.get('MSG91_TEMPLATE_NAME') ?? '';
const namespace = Deno.env.get('MSG91_TEMPLATE_NAMESPACE') ?? '';
const languageCode = Deno.env.get('MSG91_TEMPLATE_LANGUAGE') ?? 'en';

const configured = !!authKey && !!integratedNumber && !!templateName && !!namespace;
const send: Send = configured
  ? msg91Client({ authKey, integratedNumber, templateName, namespace, languageCode })
  : async () => { console.error('send sms hook: MSG91 is not configured'); return 'provider_error'; };

Deno.serve((request) => handleHook(request, { secret, send }));
