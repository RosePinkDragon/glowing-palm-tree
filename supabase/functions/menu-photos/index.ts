import { optimizePhoto, PhotoError } from './photos.ts';
import { handlePhoto, type Cleanup, type Reservation } from './photos.ts';

const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/,'');
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
async function api(path: string, init: RequestInit = {}, token = service) {
  if (!base || !service) throw new Error('Missing server configuration');
  const response = await fetch(base + path,{...init,headers:{apikey:service,authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(10000)});
  if (!response.ok) {
    let code = ''; try { code = (await response.json()).code ?? ''; } catch { /* Do not disclose internal/provider errors. */ }
    if (code === '42501' || response.status === 403) throw new PhotoError('Admin access to this restaurant is required.',403);
    if (code === '40001') throw new PhotoError('The photo changed or the upload expired. Reload this dish before retrying.',409);
    if (code === 'P0002') throw new PhotoError('This dish no longer exists. Reload the menu.',404);
    throw new Error('Photo backend unavailable');
  }
  return response;
}
async function rpc(name: string, body: object) {
  return await (await api(`/rest/v1/rpc/${name}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
}
Deno.serve(request => handlePhoto(request,{
  user: async token => {
    // Auth server verifies the bearer; decoding JWT claims locally is insufficient.
    const response = await fetch(`${base}/auth/v1/user`,{headers:{apikey:service,authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
    if (!response.ok) return null;
    const user = await response.json(); return typeof user.id === 'string' ? user.id : null;
  },
  authorize: async (actor,slug) => { await rpc('menu_photo_business',{p_actor:actor,p_slug:slug}); },
  optimize: optimizePhoto,
  reserve: async (actor,slug,item,expected) => await rpc('reserve_menu_photo',{p_actor:actor,p_slug:slug,p_item:item,p_expected:expected}) as Reservation,
  upload: async (path,data) => { await api(`/storage/v1/object/menu-images/${path}`,{method:'POST',headers:{'content-type':'image/webp','cache-control':'max-age=31536000','x-upsert':'false'},body:data as BodyInit}); },
  attach: async (actor,slug,job) => { await rpc('attach_menu_photo',{p_actor:actor,p_slug:slug,p_job:job}); },
  remove: async (actor,slug,item,expected) => { await rpc('remove_menu_photo',{p_actor:actor,p_slug:slug,p_item:item,p_expected:expected}); },
  claim: async (actor,slug) => await rpc('claim_menu_photo_cleanup',{p_actor:actor,p_slug:slug}) as Cleanup[],
  delete: async paths => { await api('/storage/v1/object/menu-images',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({prefixes:paths})}); },
  finish: async (actor,slug,job) => { await rpc('finish_menu_photo_cleanup',{p_actor:actor,p_slug:slug,p_job:job.id,p_lease:job.lease}); },
}));
