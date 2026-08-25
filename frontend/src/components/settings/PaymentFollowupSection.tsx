import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Upload, Trash2, Clock, Image as ImageIcon, Send, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface FollowupSettings {
  enabled: boolean;
  delay_hours: number;
  message: string;
  images: string[];
}

const DEFAULT: FollowupSettings = {
  enabled: true,
  delay_hours: 6,
  message: "",
  images: [],
};

const BUCKET = "listing-images";
const FOLDER = "payment-followups";
const MAX_IMAGES = 3;

const PaymentFollowupSection = () => {
  const { toast } = useToast();
  const [settings, setSettings] = useState<FollowupSettings>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const fileInputs = useRef<Array<HTMLInputElement | null>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "payment_followup")
      .maybeSingle();
    if (data?.value) {
      const v = data.value as unknown as Partial<FollowupSettings>;
      setSettings({
        enabled: v.enabled ?? true,
        delay_hours: Number(v.delay_hours) || 6,
        message: v.message || "",
        images: Array.isArray(v.images) ? v.images.slice(0, MAX_IMAGES) : [],
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const persist = async (next: FollowupSettings) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("bot_settings")
        .upsert(
          {
            key: "payment_followup",
            value: next as any,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" }
        );
      if (error) throw error;
      setSettings(next);
      toast({ title: "Saved", description: "Payment follow-up settings updated" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  const toggleEnabled = () => persist({ ...settings, enabled: !settings.enabled });

  const handleUpload = async (idx: number, file: File) => {
    setUploadingIdx(idx);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `${FOLDER}/${Date.now()}-${idx}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { cacheControl: "3600", upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const nextImages = [...settings.images];
      nextImages[idx] = pub.publicUrl;
      // trim empty holes
      const cleaned = nextImages.filter(Boolean).slice(0, MAX_IMAGES);
      await persist({ ...settings, images: cleaned });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    }
    setUploadingIdx(null);
  };

  const removeImage = async (idx: number) => {
    const cleaned = settings.images.filter((_, i) => i !== idx);
    await persist({ ...settings, images: cleaned });
  };

  // ── Upcoming follow-up queue ──────────────────────────
  interface QueueRow {
    listing_id: string;
    phone: string | null;
    name: string | null;
    title: string;
    next_send_at: string;
    due: boolean;
    already_sent_at: string | null;
  }
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    const { data, error } = await supabase.functions.invoke("send-payment-followups-taktak", {
      body: { action: "queue" },
    });
    if (error) {
      toast({ title: "Queue error", description: error.message, variant: "destructive" });
    } else {
      setQueue((data?.queue || []) as QueueRow[]);
    }
    setQueueLoading(false);
  }, [toast]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const sendNow = async (listingId: string) => {
    setSendingId(listingId);
    const { data, error } = await supabase.functions.invoke("send-payment-followups-taktak", {
      body: { action: "send", listing_id: listingId },
    });
    if (error || data?.success === false) {
      toast({
        title: "Not delivered",
        description: error?.message || data?.result?.error || data?.result?.status || "Send failed",
        variant: "destructive",
      });
    } else {
      toast({ title: "Sent", description: "Personalized follow-up delivered" });
    }
    setSendingId(null);
    loadQueue();
  };

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
      timeZone: "Asia/Colombo",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-card p-6">
        <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading follow-up settings...
        </div>
      </div>
    );
  }

  const slots = Array.from({ length: MAX_IMAGES }, (_, i) => settings.images[i] || null);

  return (
    <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${settings.enabled ? "bg-warning/15" : "bg-muted"}`}>
            <Clock className={`h-5 w-5 ${settings.enabled ? "text-warning" : "text-muted-foreground"}`} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-card-foreground">Pending Payment Follow-up</h3>
            <p className="text-[11px] text-muted-foreground">
              Sent automatically to sellers who haven't paid after receiving payment details
            </p>
          </div>
        </div>
        <Switch checked={settings.enabled} onCheckedChange={toggleEnabled} disabled={saving} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Delay (hours after payment details sent)</Label>
          <Input
            type="number"
            min={1}
            max={72}
            value={settings.delay_hours}
            onChange={(e) =>
              setSettings({ ...settings, delay_hours: Math.max(1, Number(e.target.value) || 6) })
            }
            className="text-sm"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Follow-up message (no AI — sent as-is)</Label>
        <Textarea
          value={settings.message}
          onChange={(e) => setSettings({ ...settings, message: e.target.value })}
          placeholder="Encouraging message with testimonials..."
          className="text-sm min-h-[140px]"
          rows={6}
        />
        <p className="text-[11px] text-muted-foreground">
          Use *bold* (single asterisks) — WhatsApp formatting. Attached to the last image as caption.
          Personalization: <code>{"{name}"}</code> <code>{"{title}"}</code> <code>{"{price}"}</code> <code>{"{fee}"}</code> <code>{"{buyers}"}</code> (live buyer demand count; auto-appended as a highlight if unused).
          If none are used, a personalized Sinhala header (name + listing + fee) is added automatically.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground flex items-center gap-1">
          <ImageIcon className="h-3 w-3" /> Testimonial images (up to {MAX_IMAGES})
        </Label>
        <div className="grid grid-cols-3 gap-3">
          {slots.map((url, idx) => (
            <div
              key={idx}
              className="relative aspect-square rounded-lg border border-dashed border-border bg-muted/20 flex items-center justify-center overflow-hidden group"
            >
              {url ? (
                <>
                  <img src={url} alt={`Testimonial ${idx + 1}`} className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeImage(idx)}
                    className="absolute top-1.5 right-1.5 h-7 w-7 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                    aria-label="Remove image"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : uploadingIdx === idx ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <button
                  onClick={() => fileInputs.current[idx]?.click()}
                  className="flex flex-col items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
                >
                  <Upload className="h-5 w-5" />
                  <span>Upload</span>
                </button>
              )}
              <input
                ref={(el) => (fileInputs.current[idx] = el)}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(idx, f);
                  e.target.value = "";
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">
            Upcoming follow-ups ({queue.length}) — times in Colombo
          </Label>
          <Button size="sm" variant="ghost" onClick={loadQueue} disabled={queueLoading}>
            <RefreshCw className={`h-3 w-3 mr-1 ${queueLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        {queue.length === 0 ? (
          <p className="text-[11px] text-muted-foreground py-2">
            {queueLoading ? "Loading queue..." : "No pending-payment sellers in the queue."}
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {queue.map((row) => (
              <div key={row.listing_id} className="flex items-center gap-3 p-3 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-card-foreground truncate">{row.title}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {row.name || "Unknown"} · {row.phone ? `+${row.phone}` : "no phone"}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {row.already_sent_at ? (
                    <span className="text-[11px] text-muted-foreground">
                      Sent {fmt(row.already_sent_at)}
                    </span>
                  ) : row.due ? (
                    <span className="text-[11px] font-medium text-warning">Due now</span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      Next: {fmt(row.next_send_at)}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={sendingId === row.listing_id}
                  onClick={() => sendNow(row.listing_id)}
                >
                  {sendingId === row.listing_id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                  <span className="ml-1">{row.already_sent_at ? "Resend" : "Send now"}</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>


      <Button
        size="sm"
        onClick={() => persist(settings)}
        disabled={saving}
        className="w-full"
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
        Save Follow-up Settings
      </Button>
    </div>
  );
};

export default PaymentFollowupSection;
