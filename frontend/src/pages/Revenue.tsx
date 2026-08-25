import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import StatCard from "@/components/admin/StatCard";
import {
  DollarSign, Calendar, TrendingUp, Receipt, CreditCard, Landmark,
  BarChart3, Layers, Activity, ArrowUpRight,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";

type RevRow = {
  id: string;
  user_id: string | null;
  type: string;
  amount: number;
  description: string | null;
  created_at: string;
};

type PaymentRow = {
  id: string;
  amount: number;
  status: string;
  provider: string | null;
  created_at: string;
  listing_id: string | null;
  listings?: { title: string | null; category: string | null } | null;
};

const CHART_COLORS = ["#25D366", "#128C7E", "#075E54", "#34B7F1", "#ECE5DD", "#FFB020", "#F45B69"];

const Revenue = () => {
  const [revenue, setRevenue] = useState<RevRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<7 | 30 | 90>(30);

  useEffect(() => {
    (async () => {
      const [r, p] = await Promise.all([
        supabase.from("revenue").select("*").order("created_at", { ascending: false }),
        supabase
          .from("payments")
          .select("id, amount, status, provider, created_at, listing_id, listings(title, category)")
          .eq("status", "paid")
          .order("created_at", { ascending: false }),
      ]);
      setRevenue((r.data as any) || []);
      setPayments((p.data as any) || []);
      setLoading(false);
    })();
  }, []);

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfDay - 86400_000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();

  const total = revenue.reduce((s, r) => s + Number(r.amount), 0);
  const today = revenue.filter((r) => new Date(r.created_at).getTime() >= startOfDay).reduce((s, r) => s + Number(r.amount), 0);
  const yesterday = revenue
    .filter((r) => {
      const t = new Date(r.created_at).getTime();
      return t >= startOfYesterday && t < startOfDay;
    })
    .reduce((s, r) => s + Number(r.amount), 0);
  const monthTotal = revenue.filter((r) => new Date(r.created_at).getTime() >= startOfMonth).reduce((s, r) => s + Number(r.amount), 0);
  const lastMonthTotal = revenue
    .filter((r) => {
      const t = new Date(r.created_at).getTime();
      return t >= startOfLastMonth && t < startOfMonth;
    })
    .reduce((s, r) => s + Number(r.amount), 0);
  const listingFees = revenue.filter((r) => r.type === "listing_fee").reduce((s, r) => s + Number(r.amount), 0);
  const avgTxn = revenue.length ? total / revenue.length : 0;
  const monthGrowth = lastMonthTotal > 0 ? ((monthTotal - lastMonthTotal) / lastMonthTotal) * 100 : null;

  // Daily series for the selected range
  const dailySeries = useMemo(() => {
    const buckets = new Map<string, { date: string; amount: number; txns: number }>();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (range - 1)).getTime();
    for (let i = 0; i < range; i++) {
      const d = new Date(start + i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { date: key.slice(5), amount: 0, txns: 0 });
    }
    revenue.forEach((r) => {
      const t = new Date(r.created_at).getTime();
      if (t < start) return;
      const key = new Date(r.created_at).toISOString().slice(0, 10);
      const row = buckets.get(key);
      if (row) {
        row.amount += Number(r.amount);
        row.txns += 1;
      }
    });
    return Array.from(buckets.values());
  }, [revenue, range]);

  // Revenue by type
  const byType = useMemo(() => {
    const map = new Map<string, number>();
    revenue.forEach((r) => map.set(r.type, (map.get(r.type) || 0) + Number(r.amount)));
    return Array.from(map.entries()).map(([name, value]) => ({
      name: name.replace(/_/g, " "),
      value,
    })).sort((a, b) => b.value - a.value);
  }, [revenue]);

  // Revenue by payment provider (card vs bank)
  const byProvider = useMemo(() => {
    const map = new Map<string, { amount: number; count: number }>();
    payments.forEach((p) => {
      const label =
        p.provider === "onepay" ? "Card (OnePay)"
        : p.provider === "manual_bank_transfer" ? "Bank Transfer"
        : p.provider || "Other";
      const row = map.get(label) || { amount: 0, count: 0 };
      row.amount += Number(p.amount);
      row.count += 1;
      map.set(label, row);
    });
    return Array.from(map.entries()).map(([name, v]) => ({ name, value: v.amount, count: v.count }));
  }, [payments]);

  // Revenue by listing category (top 8)
  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    payments.forEach((p) => {
      const cat = p.listings?.category || "Uncategorized";
      map.set(cat, (map.get(cat) || 0) + Number(p.amount));
    });
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [payments]);

  // Top 5 earning days all-time
  const topDays = useMemo(() => {
    const map = new Map<string, number>();
    revenue.forEach((r) => {
      const key = new Date(r.created_at).toISOString().slice(0, 10);
      map.set(key, (map.get(key) || 0) + Number(r.amount));
    });
    return Array.from(map.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
  }, [revenue]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Revenue</h1>
        <p className="text-sm text-muted-foreground mt-1">Monetization and earnings overview</p>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Revenue" value={`LKR ${total.toLocaleString()}`} icon={DollarSign} />
        <StatCard title="Today" value={`LKR ${today.toLocaleString()}`} icon={Calendar} />
        <StatCard title="Yesterday" value={`LKR ${yesterday.toLocaleString()}`} icon={Calendar} />
        <StatCard title="This Month" value={`LKR ${monthTotal.toLocaleString()}`} icon={TrendingUp} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Last Month" value={`LKR ${lastMonthTotal.toLocaleString()}`} icon={BarChart3} />
        <StatCard
          title="MoM Growth"
          value={monthGrowth === null ? "—" : `${monthGrowth >= 0 ? "+" : ""}${monthGrowth.toFixed(1)}%`}
          icon={ArrowUpRight}
        />
        <StatCard title="Transactions" value={String(revenue.length)} icon={Activity} />
        <StatCard title="Avg / Txn" value={`LKR ${Math.round(avgTxn).toLocaleString()}`} icon={Receipt} />
      </div>

      {/* Daily chart */}
      <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h3 className="text-sm font-semibold text-card-foreground">Daily Revenue</h3>
            <p className="text-xs text-muted-foreground">Last {range} days</p>
          </div>
          <div className="flex gap-1 text-xs">
            {[7, 30, 90].map((n) => (
              <button
                key={n}
                onClick={() => setRange(n as 7 | 30 | 90)}
                className={`px-3 py-1 rounded-md border transition-colors ${
                  range === n ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"
                }`}
              >
                {n}d
              </button>
            ))}
          </div>
        </div>
        <div className="p-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dailySeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                formatter={(v: any) => [`LKR ${Number(v).toLocaleString()}`, "Revenue"]}
              />
              <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Type + Provider */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          <div className="border-b border-border px-6 py-4 flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-card-foreground">By Revenue Type</h3>
          </div>
          <div className="p-4 h-64">
            {byType.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={byType} dataKey="value" nameKey="name" outerRadius={90} label={(e) => `${e.name}`}>
                    {byType.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => `LKR ${Number(v).toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          <div className="border-b border-border px-6 py-4 flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-card-foreground">By Payment Method</h3>
          </div>
          <div className="divide-y divide-border">
            {byProvider.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground text-center">No paid transactions yet</div>
            ) : (
              byProvider.map((p) => (
                <div key={p.name} className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-3">
                    {p.name.startsWith("Card") ? <CreditCard className="h-4 w-4 text-primary" /> : <Landmark className="h-4 w-4 text-primary" />}
                    <div>
                      <p className="text-sm font-medium text-card-foreground">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.count} transactions</p>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-card-foreground">LKR {p.value.toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Category + Top days */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          <div className="border-b border-border px-6 py-4">
            <h3 className="text-sm font-semibold text-card-foreground">Revenue by Listing Category</h3>
            <p className="text-xs text-muted-foreground">Top 8 categories by paid listing fees</p>
          </div>
          <div className="p-4 h-72">
            {byCategory.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">No paid listings yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byCategory} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis type="number" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip formatter={(v: any) => [`LKR ${Number(v).toLocaleString()}`, "Revenue"]} />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
          <div className="border-b border-border px-6 py-4">
            <h3 className="text-sm font-semibold text-card-foreground">Top Earning Days</h3>
            <p className="text-xs text-muted-foreground">All-time top 5</p>
          </div>
          <div className="divide-y divide-border">
            {topDays.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground text-center">No data</div>
            ) : (
              topDays.map((d, i) => (
                <div key={d.date} className="flex items-center justify-between px-6 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-7 w-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                      {i + 1}
                    </div>
                    <p className="text-sm font-medium text-card-foreground">
                      {new Date(d.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-card-foreground">LKR {d.amount.toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Transaction History */}
      <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-card-foreground">Transaction History</h3>
          <p className="text-xs text-muted-foreground">{revenue.length} total • Listing fees: LKR {listingFees.toLocaleString()}</p>
        </div>
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
        ) : revenue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <DollarSign className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">No transactions yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border max-h-[600px] overflow-y-auto">
            {revenue.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-6 py-3">
                <div>
                  <p className="text-sm font-medium text-card-foreground capitalize">{r.type.replace(/_/g, " ")}</p>
                  <p className="text-xs text-muted-foreground">{r.description || "—"}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-card-foreground">LKR {Number(r.amount).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Revenue;
