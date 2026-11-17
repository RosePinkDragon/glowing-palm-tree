import { handlePhoto, initializeDecoder, optimizePhoto, PhotoError, type PhotoPorts, MAX_BYTES } from './photos.ts';
import { ImageMagick, MagickColors, MagickFormat } from '@imagemagick/magick-wasm';
function assert(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const item = '20000000-0000-4000-8000-000000000001';
const request = (action = 'upload', bytes = new Uint8Array([1]), token = 'good') => new Request('https://example.test', {
  method:'POST',headers:{authorization:`Bearer ${token}`,'x-business-slug':'ammu-sammu','x-menu-item':item,'x-photo-action':action,'content-type':'image/jpeg'},body:bytes,
});
function fixture() {
  const calls: string[] = [];
  const ports: PhotoPorts = {
    user: async token => { calls.push('user'); return token === 'good' ? 'owner' : null; },
    authorize: async () => { calls.push('authorize'); },
    optimize: async () => { calls.push('decode'); return {card:new Uint8Array([1]),detail:new Uint8Array([2])}; },
    reserve: async () => { calls.push('reserve'); return {id:'job',base:'business/dish/job'}; },
    upload: async path => { calls.push(`upload:${path}`); },
    attach: async () => { calls.push('attach'); },
    remove: async () => { calls.push('remove'); },
    claim: async () => { calls.push('claim'); return []; },
    delete: async () => { calls.push('delete'); },
    finish: async () => { calls.push('finish'); },
  };
  return {ports,calls};
}
Deno.test('unauthenticated and other-business/customer requests cannot decode or touch storage', async () => {
  const {ports,calls} = fixture();
  assert((await handlePhoto(request('upload',undefined,'wrong'),ports)).status === 401,'bad token accepted');
  assert(calls.join(',') === 'user','work before authentication');
  for (const action of ['upload','remove','cleanup']) {
    calls.length = 0; ports.authorize = async () => { calls.push('deny'); throw new PhotoError('Admin required',403); };
    assert((await handlePhoto(request(action),ports)).status === 403,'business membership bypass');
    assert(calls.join(',') === 'user,deny','denied request touched storage');
  }
});
Deno.test('streamed bytes over 5 MB and decoder failures are refused before reservation', async () => {
  const {ports,calls} = fixture();
  assert((await handlePhoto(request('upload',new Uint8Array(MAX_BYTES+1)),ports)).status === 413,'oversize accepted');
  assert(!calls.includes('reserve') && !calls.includes('decode'),'oversize performed work');
  calls.length = 0; ports.optimize = async () => { throw new PhotoError('Damaged image'); };
  assert((await handlePhoto(request(),ports)).status === 400,'bad contents accepted');
  assert(!calls.includes('reserve'),'bad image reserved');
});
Deno.test('both optimized assets follow durable reservation; only then attach and drain', async () => {
  const {ports,calls} = fixture();
  assert((await handlePhoto(request(),ports)).status === 200,'upload failed');
  assert(calls.join(',') === 'user,authorize,decode,reserve,upload:business/dish/job/card.webp,upload:business/dish/job/detail.webp,attach,claim','unsafe upload order');
});
Deno.test('partial upload or failed attachment never attaches/acknowledges cleanup; reservation remains', async () => {
  for (const failure of ['upload','attach']) {
    const {ports,calls} = fixture();
    if (failure === 'upload') ports.upload = async () => { calls.push('upload-failed'); throw new Error('storage'); };
    else ports.attach = async () => { calls.push('attach-failed'); throw new PhotoError('Photo changed',409); };
    const response = await handlePhoto(request(),ports);
    assert(response.status === (failure === 'upload' ? 503 : 409),'wrong failure status');
    assert(calls.includes('reserve') && !calls.includes('claim') && !calls.includes('finish'),'failure lost durable reservation');
    if (failure === 'upload') assert(!calls.includes('attach'),'partial upload attached');
  }
});
Deno.test('cleanup failure remains retryable and preserves the committed photo result', async () => {
  const {ports,calls} = fixture();
  ports.claim = async () => [{id:'old',base:'business/dish/old',lease:'lease'}];
  ports.delete = async paths => { assert(paths.join(',') === 'business/dish/old/card.webp,business/dish/old/detail.webp','wrong cleanup paths'); throw new Error('storage unavailable'); };
  const response = await handlePhoto(request('remove'),ports);
  const result = await response.json();
  assert(response.status === 200 && result.saved && !result.cleanupComplete,'committed result hidden');
  assert(calls.includes('remove') && !calls.includes('finish'),'failed cleanup acknowledged');
  ports.delete = async () => { calls.push('delete'); };
  assert((await (await handlePhoto(request('cleanup'),ports)).json()).cleanupComplete,'retry failed');
  assert(calls.includes('finish'),'retry not acknowledged');
});
Deno.test('actual JPEG PNG and WebP decode to stripped display-sized static WebP', async () => {
  await initializeDecoder();
  for (const format of [MagickFormat.Jpeg,MagickFormat.Png,MagickFormat.WebP]) {
    const original = ImageMagick.read(MagickColors.White,1400,1000,image => image.write(format,bytes => bytes.slice()));
    const optimized = await optimizePhoto(original);
    for (const [bytes,width] of [[optimized.card,320],[optimized.detail,960]] as const) {
      ImageMagick.read(bytes,image => { assert(image.format === MagickFormat.WebP && image.width === width,'wrong display asset'); assert(image.profileNames.length === 0,'metadata leaked'); });
    }
    let rejected = false; try { await optimizePhoto(original.slice(0,25)); } catch (e) { rejected = e instanceof PhotoError; }
    assert(rejected,'truncated header accepted');
  }
  for (const bytes of [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),ImageMagick.read(MagickColors.White,2,2,image => image.write(MagickFormat.Gif,b => b.slice()))]) {
    let rejected = false; try { await optimizePhoto(bytes); } catch (e) { rejected = e instanceof PhotoError; }
    assert(rejected,'unsupported contents accepted');
  }
});

Deno.test('real HTTP adapter accepts empty void RPC replies and continues the cleanup batch', async () => {
  const originalFetch = globalThis.fetch, originalServe = Deno.serve, originalEnv = Deno.env.get;
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const calls: string[] = [];
  let emptyStatus = 204;
  const jobs = [{id:'old-one',base:'business/dish/one',lease:'lease-one'},{id:'old-two',base:'business/dish/two',lease:'lease-two'}];
  try {
    // Import the deployed entrypoint while capturing its server callback. Only
    // HTTP boundaries are mocked: the actual api/rpc/ports code runs unchanged.
    Deno.env.get = key => key === 'SUPABASE_URL' ? 'https://adapter.test' : key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'test-server-key' : undefined;
    Deno.serve = ((callback: (request: Request) => Promise<Response>) => { handler = callback; }) as unknown as typeof Deno.serve;
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user') return Response.json({id:'verified-owner'});
      const body = JSON.parse(String(init?.body));
      if (path === '/rest/v1/rpc/menu_photo_business') {
        assert(body.p_actor === 'verified-owner' && body.p_slug === 'ammu-sammu','verified actor/business lost');
        return Response.json('business');
      }
      if (path === '/rest/v1/rpc/remove_menu_photo') { calls.push('remove'); return new Response(null,{status:emptyStatus}); }
      if (path === '/rest/v1/rpc/claim_menu_photo_cleanup') { calls.push('claim'); return Response.json(jobs); }
      if (path === '/storage/v1/object/menu-images') {
        const version = body.prefixes[0].includes('/one/') ? 'one' : 'two';
        calls.push(`delete:${version}`); return Response.json([]);
      }
      if (path === '/rest/v1/rpc/finish_menu_photo_cleanup') {
        calls.push(`finish:${body.p_job}`); return new Response(null,{status:emptyStatus});
      }
      throw new Error(`Unexpected adapter request: ${path}`);
    };
    await import('./index.ts');
    assert(handler,'entrypoint did not register its handler');
    // PostgREST uses 204 for RETURNS void. Accept other empty successful replies
    // too, while continuing to parse the JSON returned by claim/authorize RPCs.
    for (emptyStatus of [204,200]) {
      calls.length = 0;
      const response = await handler(request('remove'));
      const result = await response.json();
      assert(response.status === 200 && result.saved && result.cleanupComplete,`empty HTTP ${emptyStatus} became a false failure`);
      assert(calls.join(',') === 'remove,claim,delete:one,finish:old-one,delete:two,finish:old-two','cleanup stopped after an empty finish reply');
    }
  } finally { globalThis.fetch = originalFetch; Deno.serve = originalServe; Deno.env.get = originalEnv; }
});
