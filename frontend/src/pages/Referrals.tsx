import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Gift, Users, Wallet, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Payout {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  account_snapshot: any;
  created_at: string;
}

const statusStyles: Record<string, string> = {
  pending: "bg-warning/10 text-warning border-warning/20",
  approved: "bg-info/10 text-info border-info/20",
  paid: "bg-success/10 text-success border-success/20",
  rejected: "bg-destructive/10 text-destructive border-destructive/20",
};

const Referrals = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [rewards, setRewards] = useState<any[]>([]);
  const [referrals, setReferrals] = useState<any[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: p }, { data: rw }, { data: rf }, { data: users }] = await Promise.all([
      supabase.from("referral_payouts").select("*").order("created_at", { ascending: false }),
      supabase.from("referral_rewards").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("referrals").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("marketplace_users").select("id, phone_number, display_name, referral_code"),
    ]);
    const map: Record<string, string> = {};
    for (const u of users || []) map[u.id] = u.display_name || `+${u.phone_number}`;
    setNames(map);
    setPayouts((p as Payout[]) || []);
    setRewards(rw || []);
    setReferrals(rf || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (id: string, status: string) => {
    const { error } = await supabase.from("referral_payouts").update({ status }).eq("id", id);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else {
      toast({ title: "Updated", description: `Payout marked ${status}` });
      load();
    }
  };

  const totalAwarded = rewards.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalPaid = payouts.filter((p) => p.status === "paid").reduce((s, p) => s + Number(p.amount || 0), 0);
  const pendingCount = payouts.filter((p) => p.status === "pending").length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-foreground">Referrals</h1>
        <p className="text-sm text-muted-foreground">Referral attribution, rewards and payout requests</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat icon={Users} label="Referred Users" value={referrals.length} />
        <Stat icon={Gift} label="Rewards Awarded" value={`LKR ${totalAwarded}`} />
        <Stat icon={Wallet} label="Paid Out" value={`LKR ${totalPaid}`} />
        <Stat icon={Wallet} label="Pending Requests" value={pendingCount} />
      </div>

      <Card className="shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Payout Requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {payouts.length === 0 && <p className="text-sm text-muted-foreground">No payout requests yet.</p>}
          {payouts.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-0">
              <div className="text-sm">
                <p className="font-medium text-foreground">{names[p.user_id] || p.user_id}</p>
                <p className="text-xs text-muted-foreground">
                  {p.account_snapshot?.bank_name} · {p.account_snapshot?.account_name} ·{" "}
                  {p.account_snapshot?.account_number}
                  {p.account_snapshot?.branch ? ` · ${p.account_snapshot.branch}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">LKR {p.amount}</span>
                <Badge variant="outline" className={statusStyles[p.status] || ""}>{p.status}</Badge>
                {p.status !== "paid" && (
                  <Button size="sm" onClick={() => setStatus(p.id, "paid")}>
                    <Check className="h-4 w-4 mr-1" /> Mark Paid
                  </Button>
                )}
                {p.status === "pending" && (
                  <Button size="sm" variant="outline" onClick={() => setStatus(p.id, "rejected")}>
                    <X className="h-4 w-4 mr-1" /> Reject
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="shadow-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Recent Rewards</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rewards.length === 0 && <p className="text-sm text-muted-foreground">No rewards yet.</p>}
          {rewards.slice(0, 50).map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-border pb-2 last:border-0">
              <div className="text-sm">
                <p className="text-foreground">
                  {names[r.referrer_id] || r.referrer_id}{" "}
                  <span className="text-muted-foreground">
                    ← {r.reward_type === "seller_listing" ? "referred seller paid" : "referred buyer searched"}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</p>
              </div>
              <span className="text-sm font-semibold text-success">+LKR {r.amount}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
};

const Stat = ({ icon: Icon, label, value }: { icon: any; label: string; value: string | number }) => (
  <Card className="shadow-card">
    <CardContent className="flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div>
        <p className="text-lg font-bold text-foreground">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </CardContent>
  </Card>
);

export default Referrals;
