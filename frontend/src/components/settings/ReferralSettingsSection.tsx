import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Gift } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface ReferralConfig {
  enabled: boolean;
  seller_percent: number;
  buyer_reward: number;
  min_redeem: number;
  bot_number: string;
}

const DEFAULT: ReferralConfig = {
  enabled: true,
  seller_percent: 20,
  buyer_reward: 5,
  min_redeem: 1000,
  bot_number: "94722756169",
};

const ReferralSettingsSection = () => {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ReferralConfig>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("bot_settings").select("value").eq("key", "referral").maybeSingle();
    if (data?.value) {
      const v = data.value as unknown as Partial<ReferralConfig>;
      setCfg({
        enabled: v.enabled !== false,
        seller_percent: Number(v.seller_percent) || DEFAULT.seller_percent,
        buyer_reward: Number(v.buyer_reward) ?? DEFAULT.buyer_reward,
        min_redeem: Number(v.min_redeem) || DEFAULT.min_redeem,
        bot_number: String(v.bot_number || DEFAULT.bot_number),
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("bot_settings")
      .upsert({ key: "referral", value: cfg as any, updated_at: new Date().toISOString() }, { onConflict: "key" });
    setSaving(false);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else toast({ title: "Saved", description: "Referral settings updated" });
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-card p-6">
        <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading referral settings...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
          <Gift className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-card-foreground">Referral Program</h3>
          <p className="text-xs text-muted-foreground">Rewards for users who bring sellers and buyers</p>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <Label className="text-sm">Program enabled</Label>
        <Switch checked={cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Seller reward (% of listing fee)</Label>
          <Input
            type="number"
            value={cfg.seller_percent}
            onChange={(e) => setCfg({ ...cfg, seller_percent: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Buyer reward (LKR per referred buyer)</Label>
          <Input
            type="number"
            value={cfg.buyer_reward}
            onChange={(e) => setCfg({ ...cfg, buyer_reward: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Minimum redeem threshold (LKR)</Label>
          <Input
            type="number"
            value={cfg.min_redeem}
            onChange={(e) => setCfg({ ...cfg, min_redeem: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Bot WhatsApp number (link target)</Label>
          <Input value={cfg.bot_number} onChange={(e) => setCfg({ ...cfg, bot_number: e.target.value })} />
        </div>
      </div>

      <Button onClick={save} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} Save
      </Button>
    </div>
  );
};

export default ReferralSettingsSection;
