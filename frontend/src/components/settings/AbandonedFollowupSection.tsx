import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Upload, Trash2, UserX, Image as ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface AbandonedSettings {
  enabled: boolean;
  delay_hours: number;
  window_hours: number;
  message: string;
  images: string[];
}

const DEFAULT_IMAGES = [
  "https://ipqmlizuuqswtmnukulw.supabase.co/storage/v1/object/public/listing-images/testimonials/t1.jpg",
  "https://ipqmlizuuqswtmnukulw.supabase.co/storage/v1/object/public/listing-images/testimonials/t2.jpg",
  "https://ipqmlizuuqswtmnukulw.supabase.co/storage/v1/object/public/listing-images/testimonials/t3.jpg",
];

const DEFAULT: AbandonedSettings = {
  enabled: true,
  delay_hours: 6,
  window_hours: 9,
  message: "",
  images: DEFAULT_IMAGES,
};

const BUCKET = "listing-images";
const FOLDER = "abandoned-followups";
const MAX_IMAGES = 3;

const AbandonedFollowupSection = () => {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AbandonedSettings>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingIdx, setUploadingIdx] = useState<number | null>(null);
  const fileInputs = useRef<Array<HTMLInputElement | null>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "abandoned_followup")
      .maybeSingle();
    if (data?.value) {
      const v = data.value as unknown as Partial<AbandonedSettings>;
      setSettings({
        enabled: v.enabled ?? true,
        delay_hours: Number(v.delay_hours) || 6,
        window_hours: Number(v.window_hours) || 9,
        message: v.message || "",
        images:
          Array.isArray(v.images) && v.images.length
            ? v.images.slice(0, MAX_IMAGES)
            : DEFAULT_IMAGES,
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const persist = async (next: AbandonedSettings) => {
    setSaving(true);
    try {
      const { error } = await supabase.from("bot_settings").upsert(
        {
          key: "abandoned_followup",
          value: next as any,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
      if (error) throw error;
      setSettings(next);
      toast({ title: "Saved", description: "Abandoned-user follow-up settings updated" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

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
      await persist({ ...settings, images: nextImages.filter(Boolean).slice(0, MAX_IMAGES) });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    }
    setUploadingIdx(null);
  };

  const removeImage = async (idx: number) =>
    persist({ ...settings, images: settings.images.filter((_, i) => i !== idx) });

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-card p-6">
        <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading abandoned follow-up settings...
        </div>
      </div>
    );
  }

  const slots = Array.from({ length: MAX_IMAGES }, (_, i) => settings.images[i] || null);

  return (
    <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${
              settings.enabled ? "bg-primary/15" : "bg-muted"
            }`}
          >
            <UserX className={`h-5 w-5 ${settings.enabled ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-card-foreground">Abandoned User Follow-up</h3>
            <p className="text-[11px] text-muted-foreground">
              Sent to people who chatted with the bot but never posted a listing
            </p>
          </div>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={() => persist({ ...settings, enabled: !settings.enabled })}
          disabled={saving}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Send after (hours since last message)</Label>
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
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Window closes after (hours)</Label>
          <Input
            type="number"
            min={2}
            max={168}
            value={settings.window_hours}
            onChange={(e) =>
              setSettings({ ...settings, window_hours: Math.max(2, Number(e.target.value) || 9) })
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
          placeholder="Leave empty to use the built-in Sinhala nudge..."
          className="text-sm min-h-[140px]"
          rows={6}
        />
        <p className="text-[11px] text-muted-foreground">
          Use *bold* (single asterisks) — WhatsApp formatting. Sent as the caption of the last image.
          Personalization: <code>{"{name}"}</code>.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground flex items-center gap-1">
          <ImageIcon className="h-3 w-3" /> Testimonial screenshots (all {MAX_IMAGES} sent together)
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

      <Button size="sm" onClick={() => persist(settings)} disabled={saving} className="w-full">
        {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
        Save Abandoned Follow-up Settings
      </Button>
    </div>
  );
};

export default AbandonedFollowupSection;
