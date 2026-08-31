// VPS S3-compatible storage uploader using aws4fetch (works reliably on
// MinIO/self-hosted S3 from Deno; the AWS SDK v3 hangs on PutObject there).
import { AwsClient } from "npm:aws4fetch@1.0.20";

const ENDPOINT = (Deno.env.get("S3_ENDPOINT") || "").replace(/\/+$/, "");
const BUCKET = Deno.env.get("S3_BUCKET") || "image";
const REGION = Deno.env.get("S3_REGION") || "us-east-1";
const ACCESS_KEY = Deno.env.get("S3_ACCESS_KEY") || "";
const SECRET_KEY = Deno.env.get("S3_SECRET_KEY") || "";

const aws = new AwsClient({
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  service: "s3",
  region: REGION,
});

let bucketEnsured = false;
async function ensureBucket() {
  if (bucketEnsured) return;
  try {
    const res = await aws.fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
    // 200 = created, 409 = already owned — both fine.
    if (!res.ok && res.status !== 409) {
      const body = await res.text();
      console.log(`[vps-storage] ensureBucket status=${res.status} body=${body.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`[vps-storage] ensureBucket error: ${(e as Error).message}`);
  }
  bucketEnsured = true;
}

function publicUrl(key: string): string {
  return `${ENDPOINT}/${BUCKET}/${encodeURI(key).replace(/%2F/g, "/")}`;
}

/**
 * Upload bytes to the VPS S3 bucket and return the public URL.
 * Throws on failure.
 */
export async function uploadToVps(
  key: string,
  body: Uint8Array | ArrayBuffer,
  contentType: string,
): Promise<string> {
  await ensureBucket();
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const url = `${ENDPOINT}/${BUCKET}/${encodeURI(key).replace(/%2F/g, "/")}`;
  const res = await aws.fetch(url, {
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VPS S3 PUT failed [${res.status}]: ${text.slice(0, 300)}`);
  }
  return publicUrl(key);
}
