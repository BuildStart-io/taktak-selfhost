// Combines the testimonial screenshots into ONE image so WhatsApp shows a
// single photo with a single caption (sending 3 separate photos looks like a
// bulk blast and reads badly on the seller's phone).
//
// The collage is built once per unique image-set and cached in storage, so a
// normal run costs a single HEAD request.

// Lazy load: a top-level deno.land/x import can fail at boot and kill the function.
let _Image: any = null;
async function loadImage(): Promise<any | null> {
  if (_Image) return _Image;
  for (const s of ["https://esm.sh/imagescript@1.2.17", "https://deno.land/x/imagescript@1.2.17/mod.ts"]) {
    try {
      const mod = await import(s);
      if (mod?.Image) { _Image = mod.Image; return _Image; }
    } catch (e) {
      console.warn("imagescript load failed", s, String(e));
    }
  }
  return null;
}

const BUCKET = "listing-images";
const TARGET_H = 1400;
const GAP = 18;

async function hashOf(value: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns a public URL of a single side-by-side collage of `images`.
 * Falls back to the first image if anything goes wrong.
 */
export async function buildCollage(supabase: any, images: string[]): Promise<string> {
  const urls = images.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, 3);
  if (urls.length === 0) return "";
  if (urls.length === 1) return urls[0];

  try {
    const key = await hashOf(urls.join("|"));
    const path = `testimonials/collage-${key}.jpg`;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = pub.publicUrl as string;

    const head = await fetch(publicUrl, { method: "HEAD" });
    if (head.ok) return publicUrl;

    const Image = await loadImage();
    if (!Image) return urls[0];

    const decoded: any[] = [];
    for (const url of urls) {
      const res = await fetch(url);
      if (!res.ok) continue;
      const img = await Image.decode(new Uint8Array(await res.arrayBuffer()));
      const scale = TARGET_H / img.height;
      decoded.push(img.resize(Math.max(1, Math.round(img.width * scale)), TARGET_H));
    }
    if (decoded.length === 0) return urls[0];
    if (decoded.length === 1) return urls[0];

    const totalW = decoded.reduce((s, i) => s + i.width, 0) + GAP * (decoded.length + 1);
    const canvas = new Image(totalW, TARGET_H + GAP * 2);
    canvas.fill(0xffffffff);

    let x = GAP;
    for (const img of decoded) {
      canvas.composite(img, x, GAP);
      x += img.width + GAP;
    }

    const bytes = await canvas.encodeJPEG(82);
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
    if (error) {
      console.warn("collage upload failed:", error.message);
      return urls[0];
    }
    return publicUrl;
  } catch (e) {
    console.warn("collage build failed:", String(e));
    return urls[0];
  }
}
