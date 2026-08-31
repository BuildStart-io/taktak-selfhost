import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ENDPOINT = (Deno.env.get("S3_ENDPOINT") || "").replace(/\/+$/, "");
const BUCKET = Deno.env.get("S3_BUCKET") || "image";
const REGION = Deno.env.get("S3_REGION") || "us-east-1";
const ACCESS_KEY = Deno.env.get("S3_ACCESS_KEY") || "";
const SECRET_KEY = Deno.env.get("S3_SECRET_KEY") || "";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

export default async function(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const aws = new AwsClient({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    service: "s3",
    region: REGION,
  });

  const key = `test/${Date.now()}_sample.png`;
  const url = `${ENDPOINT}/${BUCKET}/${key}`;
  const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

  const diag: any = { endpoint: ENDPOINT, bucket: BUCKET, url };

  try {
    const res = await aws.fetch(url, {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": "image/png" },
    });
    diag.status = res.status;
    diag.ok = res.ok;
    if (!res.ok) diag.body = (await res.text()).slice(0, 500);
    else diag.public_url = url;
  } catch (e) {
    diag.error = String((e as Error).message);
  }

  return new Response(JSON.stringify(diag, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
