import { clamp, handle } from './finish.ts';
import { makePorts } from './ports.ts';

const secret = Deno.env.get('FINISH_ACCOUNT_DELETIONS_SECRET') ?? '';
const ports = makePorts({ supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '', serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' });
const batchSize = clamp(Number(Deno.env.get('FINISH_ACCOUNT_DELETIONS_BATCH') ?? '20'), 1, 50, 20);

Deno.serve((request) => handle(request, secret, ports, { batchSize }));
