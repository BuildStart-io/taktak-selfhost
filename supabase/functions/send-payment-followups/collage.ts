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
  for (const s of ["../_shared/imagescript.js"]) {
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

    try {
      const r = await fetch("http://178.104.127.220:5000/collage-horizontal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: urls }),
      });
      
      if (!r.ok) {
        console.warn("collage microservice failed:", await r.text());
        return urls[0];
      }
      
      const bytes = await r.arrayBuffer();
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
      if (error) {
        console.warn("collage upload failed:", error.message);
        return urls[0];
      }
      return publicUrl;
    } catch (e) {
      console.warn("failed to connect to collage microservice:", String(e));
      return urls[0];
    }
  } catch (e) {
    console.warn("collage build failed:", String(e));
    return urls[0];
  }
}
