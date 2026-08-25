import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Receipt, ExternalLink, CheckCircle2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface SlipPayment {
  id: string;
  reference: string;
  listing_id: string | null;
  seller_id: string | null;
  phone_number: string | null;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  gateway_response: any;
  created_at: string;
  listings?: { title: string | null } | null;
}

const BankSlips = () => {
  const [slips, setSlips] = useState<SlipPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const fetchSlips = async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("*, listings(title)")
        .eq("provider", "bank_transfer")
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) console.error("Failed to load bank slips:", error);
      setSlips((data as any) || []);
      setLoading(false);
    };
    fetchSlips();
  }, []);

  const total = slips.reduce((s, p) => s + Number(p.amount || 0), 0);
  const paidCount = slips.filter((s) => s.status === "paid").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Bank Slips</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Bank transfer payment slips submitted by sellers via WhatsApp
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 shadow-card">
          <p className="text-xs text-muted-foreground">Total Slips</p>
          <p className="mt-1 text-2xl font-bold text-card-foreground">{slips.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5 shadow-card">
          <p className="text-xs text-muted-foreground">Verified & Paid</p>
          <p className="mt-1 text-2xl font-bold text-card-foreground">{paidCount}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5 shadow-card">
          <p className="text-xs text-muted-foreground">Total Amount</p>
          <p className="mt-1 text-2xl font-bold text-card-foreground">
            LKR {total.toLocaleString()}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden animate-fade-in">
        <div className="border-b border-border px-6 py-4">
          <h3 className="text-sm font-semibold text-card-foreground">Submitted Slips</h3>
        </div>
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
        ) : slips.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Receipt className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">No bank slips submitted yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {slips.map((s) => {
              const slipUrl: string | null = s.gateway_response?.slip_url || null;
              const extracted = s.gateway_response?.extracted || {};
              const isPaid = s.status === "paid";
              return (
                <div key={s.id} className="flex items-start gap-4 px-6 py-4">
                  <button
                    onClick={() => slipUrl && setPreview(slipUrl)}
                    className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"
                  >
                    {slipUrl ? (
                      <img
                        src={slipUrl}
                        alt="Bank slip"
                        className="h-full w-full object-cover hover:opacity-80 transition-opacity"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Receipt className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-card-foreground truncate">
                          {s.listings?.title || "Unknown listing"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {s.phone_number || "—"} · Ref: {s.reference}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold text-card-foreground">
                          {s.currency || "LKR"} {Number(s.amount).toLocaleString()}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {new Date(s.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          isPaid
                            ? "bg-success/10 text-success"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {isPaid ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <XCircle className="h-3 w-3" />
                        )}
                        {s.status}
                      </span>
                      {extracted.bank && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {extracted.bank}
                        </span>
                      )}
                      {extracted.beneficiary_name && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          → {extracted.beneficiary_name}
                        </span>
                      )}
                      {slipUrl && (
                        <a
                          href={slipUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open full image
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bank slip</DialogTitle>
          </DialogHeader>
          {preview && (
            <img src={preview} alt="Bank slip" className="w-full h-auto rounded-lg" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BankSlips;
