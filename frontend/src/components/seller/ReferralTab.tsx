import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Copy, Gift, Wallet, Loader2, Share2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export interface ReferralData {
  enabled: boolean;
  code: string | null;
  link: string | null;
  seller_percent: number;
  buyer_reward: number;
  min_redeem: number;
  total_referred: number;
  earned_total: number;
  available: number;
  paid_total: number;
  payout_account: Record<string, string>;
  rewards: { id: string; reward_type: string; amount: number; description: string | null; created_at: string }[];
  payouts: { id: string; amount: number; status: string; created_at: string }[];
}

const statusStyles: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/20",
  approved: "bg-info/10 text-info border-info/20",
  paid: "bg-success/10 text-success border-success/20",
  rejected: "bg-destructive/10 text-destructive border-destructive/20",
};

const ReferralTab = ({ referral, onRefresh }: { referral: ReferralData; onRefresh: () => void }) => {
  const { toast } = useToast();
  const acct = referral.payout_account || {};
  const [form, setForm] = useState({
    bank_name: acct.bank_name || "",
    account_name: acct.account_name || "",
    account_number: acct.account_number || "",
    branch: acct.branch || "",
  });
  const [saving, setSaving] = useState(false);
  const [redeeming, setRedeeming] = useState(false);

  const call = async (body: Record<string, unknown>) => {
    const token = localStorage.getItem("seller_session_token");
    const res = await fetch(`${SUPABASE_URL}/functions/v1/seller-dashboard-data-taktak`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ session_token: token, ...body }),
    });
    return res.json();
  };

  const saveAccount = async () => {
    setSaving(true);
    const r = await call({ action: "save_payout_account", payout_account: form });
    setSaving(false);
    if (r.success) {
      toast({ title: "Saved", description: "Your bank account details were saved." });
      onRefresh();
    } else {
      toast({ title: "Error", description: r.error || "Could not save", variant: "destructive" });
    }
  };

  const redeem = async () => {
    setRedeeming(true);
    const r = await call({ action: "request_redeem" });
    setRedeeming(false);
    if (r.success) {
      toast({ title: "Redeem requested", description: `LKR ${r.requested} is pending admin approval.` });
      onRefresh();
    } else {
      toast({ title: "Not available", description: r.error || "Could not request redeem", variant: "destructive" });
    }
  };

  const copyLink = () => {
    if (!referral.link) return;
    navigator.clipboard.writeText(referral.link);
    toast({ title: "Link copied", description: "Share it with friends to start earning." });
  };

  return (
    <div className="space-y-4">
      <Card className="shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Share2 className="h-4 w-4 text-primary" /> Your Referral Link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={referral.link || "—"} className="font-mono text-xs" />
            <Button onClick={copyLink} disabled={!referral.link} className="shrink-0">
              <Copy className="h-4 w-4 mr-1" /> Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Share this link. When someone you referred publishes a paid listing you earn{" "}
            <span className="font-semibold text-foreground">{referral.seller_percent}%</span> of their listing fee, and
            you earn <span className="font-semibold text-foreground">LKR {referral.buyer_reward}</span> when a referred
            buyer searches on TakTak. Your code: <span className="font-mono">{referral.code}</span>
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="People Referred" value={referral.total_referred} />
        <MiniStat label="Total Earned" value={`LKR ${referral.earned_total}`} />
        <MiniStat label="Available" value={`LKR ${referral.available}`} highlight />
        <MiniStat label="Paid Out" value={`LKR ${referral.paid_total}`} />
      </div>

      <Card className="shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" /> Bank Account for Payouts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Bank Name</Label>
              <Input value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Account Holder Name</Label>
              <Input value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Account Number</Label>
              <Input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Branch (optional)</Label>
              <Input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={saveAccount} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save Account
            </Button>
            <Button onClick={redeem} disabled={redeeming || referral.available < referral.min_redeem}>
              {redeeming && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              <Gift className="h-4 w-4 mr-1" /> Redeem LKR {referral.available}
            </Button>
            <span className="text-xs text-muted-foreground">Minimum redeem: LKR {referral.min_redeem}</span>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Earnings History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {referral.rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground">No earnings yet — share your link to get started.</p>
          ) : (
            referral.rewards.map((r) => (
              <div key={r.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0">
                <div>
                  <p className="text-sm text-foreground">
                    {r.reward_type === "seller_listing" ? "Referred seller published a listing" : "Referred buyer searched"}
                  </p>
                  <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</p>
                </div>
                <span className="text-sm font-semibold text-success">+LKR {r.amount}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {referral.payouts.length > 0 && (
        <Card className="shadow-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Redeem Requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {referral.payouts.map((p) => (
              <div key={p.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0">
                <div>
                  <p className="text-sm text-foreground">LKR {p.amount}</p>
                  <p className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString()}</p>
                </div>
                <Badge variant="outline" className={statusStyles[p.status] || ""}>{p.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

const MiniStat = ({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) => (
  <Card className="shadow-card">
    <CardContent className="p-4">
      <p className={`text-lg font-bold ${highlight ? "text-primary" : "text-foreground"}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </CardContent>
  </Card>
);

export default ReferralTab;
