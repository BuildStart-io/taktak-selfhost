import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, Search } from "lucide-react";

interface SearchItem {
  term: string;
  count: number;
}

const TopSearches = () => {
  const [searches, setSearches] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSearches = async () => {
      const { data } = await supabase
        .from("search_history")
        .select("query_text")
        .order("created_at", { ascending: false })
        .limit(500);

      if (data && data.length > 0) {
        const counts: Record<string, number> = {};
        data.forEach((s: any) => {
          const term = s.query_text?.toLowerCase().trim();
          if (term) counts[term] = (counts[term] || 0) + 1;
        });
        const sorted = Object.entries(counts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 6)
          .map(([term, count]) => ({ term, count }));
        setSearches(sorted);
      }
      setLoading(false);
    };
    fetchSearches();
  }, []);

  const maxCount = searches.length > 0 ? Math.max(...searches.map((s) => s.count)) : 1;

  return (
    <div className="rounded-xl border border-border bg-card shadow-card animate-fade-in">
      <div className="flex items-center gap-2 border-b border-border px-6 py-4">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-card-foreground">Top Searches</h3>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">Loading...</div>
      ) : searches.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Search className="h-8 w-8 mb-2 opacity-40" />
          <p className="text-sm">No search data yet</p>
        </div>
      ) : (
        <div className="space-y-3 p-6">
          {searches.map((search, i) => (
            <div key={search.term} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-muted-foreground w-4">{i + 1}</span>
                  <span className="text-sm font-medium text-card-foreground">{search.term}</span>
                </div>
                <span className="text-xs text-muted-foreground">{search.count}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full gradient-primary transition-all duration-500"
                  style={{ width: `${(search.count / maxCount) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TopSearches;
