import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save, Tag } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface FeeConfig {
  threshold: number;
  low: number;
  high: number;
}

const DEFAULT: FeeConfig = { threshold: 1000000, low: 300, high: 500 };

const ListingFeeSection = () => {
  const { toast } = useToast();
  const [fees, setFees] = useState<FeeConfig>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "listing_fee")
      .maybeSingle();
    if (data?.value) {
      const v = data.value as unknown as Partial<FeeConfig>;
      setFees({
        threshold: Number(v.threshold) > 0 ? Number(v.threshold) : DEFAULT.threshold,
        low: Number(v.low) > 0 ? Number(v.low) : DEFAULT.low,
        high: Number(v.high) > 0 ? Number(v.high) : DEFAULT.high,
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.from("bot_settings").upsert(
        {
          key: "listing_fee",
          value: fees as any,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
      if (error) throw error;
      toast({ title: "Saved", description: "Listing fee updated everywhere" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-card p-6">
        <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading listing fee...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
          <Tag className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-card-foreground">Listing Fee</h3>
          <p className="text-[11px] text-muted-foreground">
            Used by the bot, payment links, and follow-up messages — one source of truth.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Price threshold (LKR)</Label>
          <Input
            type="number"
            min={1}
            value={fees.threshold}
            onChange={(e) => setFees({ ...fees, threshold: Number(e.target.value) || 0 })}
            className="text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Fee below threshold</Label>
          <Input
            type="number"
            min={1}
            value={fees.low}
            onChange={(e) => setFees({ ...fees, low: Number(e.target.value) || 0 })}
            className="text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Fee at/above threshold</Label>
          <Input
            type="number"
            min={1}
            value={fees.high}
            onChange={(e) => setFees({ ...fees, high: Number(e.target.value) || 0 })}
            className="text-sm"
          />
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Current rule: listings under LKR {fees.threshold.toLocaleString()} pay LKR{" "}
        {fees.low.toLocaleString()}; listings at or above pay LKR {fees.high.toLocaleString()}.
      </p>

      <Button size="sm" onClick={save} disabled={saving} className="w-full">
        {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
        Save Listing Fee
      </Button>
    </div>
  );
};

export default ListingFeeSection;
