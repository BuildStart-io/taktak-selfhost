import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import StatCard from "@/components/admin/StatCard";
import ListingsTable from "@/components/admin/ListingsTable";
import {
  Users, ShoppingBag, Search, MessageSquare, CalendarPlus,
  DollarSign, Receipt,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  AreaChart, Area, PieChart, Pie, Cell, Legend, LabelList,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

const COLORS = {
  revenue: "#16a34a",
  listings: "#2563eb",
  paid: "#16a34a",
  pending: "#f59e0b",
};
const PIE_COLORS = ["#16a34a", "#2563eb", "#f59e0b", "#8b5cf6", "#ec4899", "#0ea5e9", "#f43f5e"];

type Range = 7 | 30 | 90 | 0; // 0 = all time

type ListingRow = {
  id: string;
  title: string;
  status: string;
  payment_status: string;
  listing_fee: number | null;
  paid_at: string | null;
  created_at: string;
  match_count: number | null;
};

type PaymentRow = {
  id: string;
  amount: number;
  status: string;
  created_at: string;
};

const SL_OFFSET = 5.5 * 60 * 60 * 1000;
const slDateKey = (iso: string) => new Date(new Date(iso).getTime() + SL_OFFSET).toISOString().slice(0, 10);
const slTodayKey = () => new Date(Date.now() + SL_OFFSET).toISOString().slice(0, 10);

const RangePicker = ({ value, onChange }: { value: Range; onChange: (r: Range) => void }) => (
  <div className="flex gap-1 text-xs">
    {[7, 30, 90, 0].map((n) => (
      <button
        key={n}
        onClick={() => onChange(n as Range)}
        className={`px-3 py-1 rounded-md border transition-colors ${
          value === n ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"
        }`}
      >
        {n === 0 ? "All" : `${n}d`}
      </button>
    ))}
  </div>
);

const ChartCard = ({
  title, subtitle, right, children, className = "",
}: { title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) => (
  <div className={`rounded-xl border border-border bg-card shadow-card overflow-hidden ${className}`}>
    <div className="flex items-start justify-between border-b border-border px-6 py-4 gap-4">
      <div>
        <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
    <div className="p-4">{children}</div>
  </div>
);

const Empty = ({ label = "No data yet" }: { label?: string }) => (
  <div className="h-full min-h-[240px] flex items-center justify-center text-sm text-muted-foreground">{label}</div>
);

const Index = () => {
  const [stats, setStats] = useState({ totalUsers: 0, totalListings: 0, totalSearches: 0, totalMessages: 0, activeListings: 0, listingsToday: 0 });
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revRange, setRevRange] = useState<Range>(30);
  const [createdRange, setCreatedRange] = useState<Range>(30);

  useEffect(() => {
    (async () => {
      const todayKey = slTodayKey();
      const todayStartUTC = new Date(new Date(todayKey + "T00:00:00.000Z").getTime() - SL_OFFSET).toISOString();

      const [users, listingsCount, searches, messages, activeListings, listingsToday, listingsData, paymentsData] = await Promise.all([
        supabase.from("marketplace_users").select("id", { count: "exact", head: true }),
        supabase.from("listings").select("id", { count: "exact", head: true }),
        supabase.from("search_history").select("id", { count: "exact", head: true }),
        supabase.from("chat_messages").select("id", { count: "exact", head: true }),
        supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "active"),
        supabase.from("listings").select("id", { count: "exact", head: true }).gte("created_at", todayStartUTC),
        supabase.from("listings").select("id,title,status,payment_status,listing_fee,paid_at,created_at,match_count").order("created_at", { ascending: false }).limit(5000),
        supabase.from("payments").select("id,amount,status,created_at").eq("status", "paid").order("created_at", { ascending: false }).limit(5000),
      ]);

      setStats({
        totalUsers: users.count || 0,
        totalListings: listingsCount.count || 0,
        totalSearches: searches.count || 0,
        totalMessages: messages.count || 0,
        activeListings: activeListings.count || 0,
        listingsToday: listingsToday.count || 0,
      });
      setListings((listingsData.data as any) || []);
      setPayments((paymentsData.data as any) || []);
      setLoading(false);
    })();
  }, []);

  // Build daily buckets by SL date within a range (0 = all-time)
  const buildDailyBuckets = (range: Range, rows: { dateKey: string; amount?: number }[]) => {
    if (range === 0) {
      const map = new Map<string, { date: string; amount: number; count: number }>();
      rows.forEach((r) => {
        const row = map.get(r.dateKey) || { date: r.dateKey, amount: 0, count: 0 };
        row.amount += r.amount || 0;
        row.count += 1;
        map.set(r.dateKey, row);
      });
      return Array.from(map.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((r) => ({ ...r, date: r.date.slice(5) }));
    }
    const buckets = new Map<string, { date: string; amount: number; count: number }>();
    const todayKey = slTodayKey();
    const todayMs = new Date(todayKey + "T00:00:00.000Z").getTime();
    for (let i = range - 1; i >= 0; i--) {
      const key = new Date(todayMs - i * 86400_000).toISOString().slice(0, 10);
      buckets.set(key, { date: key.slice(5), amount: 0, count: 0 });
    }
    rows.forEach((r) => {
      const row = buckets.get(r.dateKey);
      if (row) {
        row.amount += r.amount || 0;
        row.count += 1;
      }
    });
    return Array.from(buckets.values());
  };

  // 1. Daily Paid Listings Revenue — only listings where status=active AND payment_status=paid
  const paidActive = useMemo(
    () => listings.filter((l) => l.status === "active" && l.payment_status === "paid" && l.paid_at),
    [listings]
  );
  const revenueSeries = useMemo(
    () => buildDailyBuckets(revRange, paidActive.map((l) => ({ dateKey: slDateKey(l.paid_at!), amount: Number(l.listing_fee || 0) }))),
    [paidActive, revRange]
  );
  const todayKey = slTodayKey();
  const todaysPaid = paidActive.filter((l) => slDateKey(l.paid_at!) === todayKey);
  const todaysRevenue = todaysPaid.reduce((s, l) => s + Number(l.listing_fee || 0), 0);

  // 2. Listings Created Per Day
  const createdSeries = useMemo(
    () => buildDailyBuckets(createdRange, listings.map((l) => ({ dateKey: slDateKey(l.created_at) }))),
    [listings, createdRange]
  );

  // 3. Payment Status Distribution — Paid vs Pending only
  const statusDist = useMemo(() => {
    let paid = 0, pending = 0;
    listings.forEach((l) => {
      if (l.payment_status === "paid") paid += 1;
      else if (l.payment_status === "unpaid" || l.payment_status === "pending") pending += 1;
    });
    return [
      { name: "Paid", value: paid, color: COLORS.paid },
      { name: "Pending Payment", value: pending, color: COLORS.pending },
    ].filter((s) => s.value > 0);
  }, [listings]);
  const statusTotal = statusDist.reduce((s, r) => s + r.value, 0);

  // 4. Paid Plan Distribution
  const planDist = useMemo(() => {
    const map = new Map<string, number>();
    paidActive.forEach((l) => {
      const fee = Number(l.listing_fee || 0);
      const key = fee > 0 ? `LKR ${fee.toLocaleString()} Plan` : "Free";
      map.set(key, (map.get(key) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [paidActive]);
  const planTotal = planDist.reduce((s, r) => s + r.value, 0);

  // 5. Top 10 Suggested Active Listings
  const topSuggested = useMemo(
    () =>
      listings
        .filter((l) => l.status === "active" && (l.match_count || 0) > 0)
        .sort((a, b) => (b.match_count || 0) - (a.match_count || 0))
        .slice(0, 10)
        .map((l) => ({ name: l.title.length > 40 ? l.title.slice(0, 40) + "…" : l.title, value: l.match_count || 0 })),
    [listings]
  );

  const tooltipStyle = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">TakTak AI Marketplace Overview</p>
      </div>

      {/* Global stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard title="Total Users" value={stats.totalUsers} icon={Users} />
        <StatCard title="Active Listings" value={stats.activeListings} icon={ShoppingBag} change={`${stats.totalListings} total`} />
        <StatCard title="Searches" value={stats.totalSearches} icon={Search} />
        <StatCard title="Messages" value={stats.totalMessages} icon={MessageSquare} />
        <StatCard title="Listings Today" value={stats.listingsToday} icon={CalendarPlus} />
      </div>

      {/* Revenue KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard title="Today's Revenue" value={`LKR ${todaysRevenue.toLocaleString()}`} icon={DollarSign} changeType="positive" />
        <StatCard title="Today's Paid Listings" value={todaysPaid.length} icon={Receipt} />
      </div>

      {/* 1. Daily Paid Listings Revenue */}
      <ChartCard
        title="Daily Paid Listings Revenue"
        subtitle="Revenue generated from successfully paid, active listings"
        right={<RangePicker value={revRange} onChange={setRevRange} />}
      >
        <div className="h-80">
          {loading ? <Skeleton className="h-full w-full" /> : revenueSeries.every((d) => d.amount === 0) ? <Empty /> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: any, k: any) => k === "amount" ? [`LKR ${Number(v).toLocaleString()}`, "Revenue"] : [v, "Paid Listings"]}
                  labelFormatter={(l, p) => {
                    const d = p?.[0]?.payload;
                    return d ? `${l} • ${d.count} paid listings` : l;
                  }}
                />
                <Bar dataKey="amount" fill={COLORS.revenue} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 2. Listings Created Per Day */}
      <ChartCard
        title="Listings Created Per Day"
        subtitle="Total listings created each day regardless of payment status"
        right={<RangePicker value={createdRange} onChange={setCreatedRange} />}
      >
        <div className="h-72">
          {loading ? <Skeleton className="h-full w-full" /> : createdSeries.every((d) => d.count === 0) ? <Empty /> : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={createdSeries}>
                <defs>
                  <linearGradient id="createdFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.listings} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={COLORS.listings} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [v, "Listings Created"]} />
                <Area type="monotone" dataKey="count" stroke={COLORS.listings} strokeWidth={2} fill="url(#createdFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {/* 3 + 4: Pie + Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Payment Status Distribution" subtitle="Current listing payment status">
          <div className="h-72 relative">
            {loading ? <Skeleton className="h-full w-full" /> : statusTotal === 0 ? <Empty /> : (
              <>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusDist} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}
                      label={(e: any) => `${((e.value / statusTotal) * 100).toFixed(0)}%`}>
                      {statusDist.map((s, i) => <Cell key={i} fill={s.color} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v: any, n: any) => [`${v} listings (${((v / statusTotal) * 100).toFixed(1)}%)`, n]}
                    />
                    <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none -mt-6">
                  <div className="text-2xl font-bold text-card-foreground">{statusTotal}</div>
                  <div className="text-xs text-muted-foreground">Total Listings</div>
                </div>
              </>
            )}
          </div>
        </ChartCard>

        <ChartCard title="Paid Listing Plan Distribution" subtitle="Distribution of purchased listing plans">
          <div className="h-72 relative">
            {loading ? <Skeleton className="h-full w-full" /> : planTotal === 0 ? <Empty label="No paid listings yet" /> : (
              <>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={planDist} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2}
                      label={(e: any) => `${((e.value / planTotal) * 100).toFixed(0)}%`}>
                      {planDist.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v: any, n: any) => [`${v} listings (${((v / planTotal) * 100).toFixed(1)}%)`, n]}
                    />
                    <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none -mt-6">
                  <div className="text-2xl font-bold text-card-foreground">{planTotal}</div>
                  <div className="text-xs text-muted-foreground">Total Paid Listings</div>
                </div>
              </>
            )}
          </div>
        </ChartCard>
      </div>

      {/* 5. Top 10 Suggested */}
      <ChartCard title="Top 10 Suggested Active Listings" subtitle="Listings most frequently recommended by the recommendation engine">
        <div className="h-[420px]">
          {loading ? <Skeleton className="h-full w-full" /> : topSuggested.length === 0 ? <Empty label="No suggestions recorded yet" /> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topSuggested} layout="vertical" margin={{ left: 20, right: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={220} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [v, "Times Suggested"]} />
                <Bar dataKey="value" fill={COLORS.listings} radius={[0, 4, 4, 0]}>
                  <LabelList dataKey="value" position="right" style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      <ListingsTable />
    </div>
  );
};

export default Index;
