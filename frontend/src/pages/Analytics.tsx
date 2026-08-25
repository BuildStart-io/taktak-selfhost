import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import TopSearches from "@/components/admin/TopSearches";
import StatCard from "@/components/admin/StatCard";
import { BarChart3, Search, Users, ShoppingBag } from "lucide-react";

const Analytics = () => {
  const [stats, setStats] = useState({ searches: 0, uniqueSearchers: 0, listings: 0 });

  useEffect(() => {
    const fetchStats = async () => {
      const [searches, uniqueSearchers, listings] = await Promise.all([
        supabase.from("search_history").select("id", { count: "exact", head: true }),
        supabase.from("search_history").select("user_id"),
        supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "active"),
      ]);
      const uniqueIds = new Set((uniqueSearchers.data || []).map((s: any) => s.user_id));
      setStats({
        searches: searches.count || 0,
        uniqueSearchers: uniqueIds.size,
        listings: listings.count || 0,
      });
    };
    fetchStats();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">Search trends and marketplace insights</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Total Searches" value={stats.searches} icon={Search} />
        <StatCard title="Unique Searchers" value={stats.uniqueSearchers} icon={Users} />
        <StatCard title="Active Listings" value={stats.listings} icon={ShoppingBag} />
      </div>

      <TopSearches />
    </div>
  );
};

export default Analytics;
