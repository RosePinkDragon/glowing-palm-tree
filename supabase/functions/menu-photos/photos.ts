import { initializeImageMagick, ImageMagick, MagickColors, MagickFormat, MagickGeometry, MagickReadSettings, ResourceLimits } from '@imagemagick/magick-wasm';

export const MAX_BYTES = 5 * 1024 * 1024;
export class PhotoError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
let ready: Promise<void> | undefined;
export function initializeDecoder() {
  return ready ??= (async () => {
    // Included by config.toml static_files, alongside the pinned npm dependency.
    // Use the same relative path locally and in the Edge bundle; no runtime CDN.
    await initializeImageMagick(await Deno.readFile(new URL('./node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm',import.meta.url)));
    ResourceLimits.width = 8192n; ResourceLimits.height = 8192n;
    ResourceLimits.memory = 96n * 1024n * 1024n; ResourceLimits.disk = 0n;
    ResourceLimits.maxMemoryRequest = 64n * 1024n * 1024n;
    ResourceLimits.maxProfileSize = 1024n * 1024n; ResourceLimits.listLength = 4n;
    ResourceLimits.time = 3n;
  })();
}
function actualFormat(data: Uint8Array): MagickFormat {
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return MagickFormat.Jpeg;
  if ([137,80,78,71,13,10,26,10].every((value,i) => data[i] === value)) return MagickFormat.Png;
  const text = (from: number, to: number) => String.fromCharCode(...data.slice(from,to));
  if (text(0,4) === 'RIFF' && text(8,12) === 'WEBP') return MagickFormat.WebP;
  throw new PhotoError('Choose a JPEG, PNG or WebP photo. Its contents must match a supported image.');
}
export async function optimizePhoto(data: Uint8Array): Promise<{ card: Uint8Array; detail: Uint8Array }> {
  if (!data.length || data.length > MAX_BYTES) throw new PhotoError('Choose a photo up to 5 MB.', 413);
  const format = actualFormat(data);
  await initializeDecoder();
  try {
    return ImageMagick.read(MagickColors.Transparent,1,1,image => {
    image.onWarning = () => { throw new PhotoError('This photo is damaged. Choose another JPEG, PNG or WebP.'); };
    const settings = new MagickReadSettings();
    settings.format = format; settings.frameIndex = 0; settings.frameCount = 1;
    image.ping(data, settings);
    if (!image.width || !image.height || image.width * image.height > 16000000) {
      throw new PhotoError('Choose a photo up to 16 megapixels and 8192 pixels on either side.');
    }
    // Only the selected safe decoder is enabled for this input. A magic header
    // alone is insufficient: full decoding and re-encoding must succeed.
    image.read(data, settings);
    if (image.format !== format) throw new PhotoError('The photo contents are not a supported image.');
    image.autoOrient(); image.strip(); image.quality = 78;
    const size = (pixels: number) => { const geometry = new MagickGeometry(pixels,pixels); geometry.greater = true; image.resize(geometry); };
    size(960);
    const detail = image.write(MagickFormat.WebP, bytes => bytes.slice());
    size(320);
    const card = image.write(MagickFormat.WebP, bytes => bytes.slice());
    if (card.length > 1048576 || detail.length > 1048576) throw new PhotoError('This photo could not be optimized. Choose a smaller photo.');
    return { card, detail };
    });
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError('This photo could not be decoded within the image limits. Choose another JPEG, PNG or WebP up to 16 megapixels.');
  }
}

export interface Reservation { id: string; base: string }
export interface Cleanup extends Reservation { lease: string }
export interface PhotoPorts {
  user(token: string): Promise<string | null>;
  authorize(actor: string, slug: string): Promise<void>;
  optimize(data: Uint8Array): Promise<{ card: Uint8Array; detail: Uint8Array }>;
  reserve(actor: string, slug: string, item: string, expected: string | null): Promise<Reservation>;
  upload(path: string, data: Uint8Array): Promise<void>;
  attach(actor: string, slug: string, job: string): Promise<void>;
  remove(actor: string, slug: string, item: string, expected: string | null): Promise<void>;
  claim(actor: string, slug: string): Promise<Cleanup[]>;
  delete(paths: string[]): Promise<void>;
  finish(actor: string, slug: string, job: Cleanup): Promise<void>;
}
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-business-slug, x-menu-item, x-photo-action, x-photo-expected' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function readPhoto(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > MAX_BYTES) throw new PhotoError('Choose a photo up to 5 MB.',413);
  if (!request.body) throw new PhotoError('Choose a photo.');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let lengthRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      lengthRead += value.length;
      if (lengthRead > MAX_BYTES) { await reader.cancel(); throw new PhotoError('Choose a photo up to 5 MB.',413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!lengthRead) throw new PhotoError('Choose a photo.');
  const data = new Uint8Array(lengthRead); let offset = 0;
  for (const chunk of chunks) { data.set(chunk,offset); offset += chunk.length; }
  return data;
}
async function drain(ports: PhotoPorts, actor: string, slug: string): Promise<boolean> {
  try {
    const jobs = await ports.claim(actor,slug);
    for (const job of jobs) {
      await ports.delete([`${job.base}/card.webp`,`${job.base}/detail.webp`]);
      await ports.finish(actor,slug,job);
    }
    return jobs.length < 5;
  } catch { return false; } // The ledger remains durable; no deletion is acknowledged.
}
export async function handlePhoto(request: Request, ports: PhotoPorts): Promise<Response> {
  const reply = (body: object, status = 200) => Response.json(body,{status,headers:cors});
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
  if (request.method !== 'POST') return reply({message:'Use POST.'},405);
  try {
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) throw new PhotoError('Sign in to manage dish photos.',401);
    const actor = await ports.user(token);
    if (!actor) throw new PhotoError('Sign in again to manage dish photos.',401);
    const slug = request.headers.get('x-business-slug') ?? '';
    if (!['ammu-sammu','kokani-dine-inn'].includes(slug)) throw new PhotoError('Choose this restaurant again.');
    await ports.authorize(actor,slug);
    const action = request.headers.get('x-photo-action');
    if (action === 'cleanup') return reply({cleanupComplete:await drain(ports,actor,slug)});
    const item = request.headers.get('x-menu-item') ?? '';
    if (!uuid.test(item)) throw new PhotoError('Save this dish before adding a photo.');
    const expected = request.headers.get('x-photo-expected') || null;
    if (expected && expected.length > 256) throw new PhotoError('Reload this dish before retrying.');
    if (action === 'remove') await ports.remove(actor,slug,item,expected);
    else if (action === 'upload') {
      const data = await readPhoto(request);
      const optimized = await ports.optimize(data);
      // Reservation precedes *every* storage write, so partial uploads and crashed
      // requests are always discoverable. No original is stored.
      const job = await ports.reserve(actor,slug,item,expected);
      await ports.upload(`${job.base}/card.webp`,optimized.card);
      await ports.upload(`${job.base}/detail.webp`,optimized.detail);
      await ports.attach(actor,slug,job.id);
    } else throw new PhotoError('Choose upload, remove or cleanup.');
    return reply({saved:true,cleanupComplete:await drain(ports,actor,slug)});
  } catch (error) {
    if (error instanceof PhotoError) return reply({message:error.message},error.status);
    return reply({message:'The photo could not be saved. Reload the dish to check its current photo before retrying.'},503);
  }
}
