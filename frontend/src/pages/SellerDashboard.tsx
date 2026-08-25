import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ShoppingBag, Eye, Users, TrendingUp, Clock, LogOut, RefreshCw,
  Package, CheckCircle2, Loader2, BarChart3
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import taktakLogo from "@/assets/taktak-logo.png";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ReferralTab, { ReferralData } from "@/components/seller/ReferralTab";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

interface Listing {
  id: string;
  title: string;
  price: number;
  city: string;
  district: string;
  condition: string;
  status: string;
  category: string | null;
  images: string[] | null;
  views_count: number;
  match_count: number;
  inquiry_count: number;
  created_at: string;
  additional_details: Record<string, any> | null;
  suggested_time: {
    best_days: string[];
    best_hours: string[];
    tip: string;
  };
}

interface DashboardData {
  seller: { display_name: string | null; member_since: string };
  referral?: ReferralData;
  listings: Listing[];
  analytics: {
    total_listings: number;
    active_listings: number;
    sold_listings: number;
    total_views: number;
    total_matches: number;
    total_inquiries: number;
  };
}

const statusColors: Record<string, string> = {
  active: "bg-success/10 text-success border-success/20",
  sold: "bg-info/10 text-info border-info/20",
  expired: "bg-muted text-muted-foreground border-border",
  removed: "bg-destructive/10 text-destructive border-destructive/20",
  pending: "bg-warning/10 text-warning border-warning/20",
};

const SellerDashboard = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [markingSold, setMarkingSold] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  const sellerInfo = JSON.parse(localStorage.getItem("seller_info") || "{}");

  const fetchData = useCallback(async () => {
    const token = localStorage.getItem("seller_session_token");
    if (!token) { navigate("/login"); return; }
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/seller-dashboard-data-taktak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ session_token: token }),
      });
      if (res.status === 401) {
        localStorage.removeItem("seller_session_token");
        localStorage.removeItem("seller_info");
        navigate("/login");
        return;
      }
      const dashData = await res.json();
      setData(dashData);
    } catch {
      toast({ title: "Error", description: "Failed to load dashboard", variant: "destructive" });
    }
    setLoading(false);
  }, [navigate, toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleLogout = () => {
    localStorage.removeItem("seller_session_token");
    localStorage.removeItem("seller_info");
    navigate("/login");
  };

  const handleMarkSold = async (listingId: string) => {
    const token = localStorage.getItem("seller_session_token");
    if (!token) return;
    setMarkingSold(listingId);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/seller-dashboard-data-taktak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ session_token: token, action: "mark_sold", listing_id: listingId }),
      });
      const result = await res.json();
      if (result.success) {
        toast({ title: "Marked as Sold", description: "This listing will no longer be suggested to buyers." });
        fetchData();
      } else {
        toast({ title: "Error", description: result.error || "Failed to update", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to mark as sold", variant: "destructive" });
    }
    setMarkingSold(null);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!data) return null;
  const { analytics, listings } = data;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <img src={taktakLogo} alt="TakTak" className="h-9 w-auto" />
            <div>
              <h1 className="text-base font-bold text-foreground">Seller Dashboard</h1>
              <p className="text-xs text-muted-foreground">
                {sellerInfo.display_name || `+${sellerInfo.phone_number}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={fetchData} title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout} className="text-muted-foreground">
              <LogOut className="h-4 w-4 mr-1" /> Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatMini icon={Package} label="Total Listings" value={analytics.total_listings} />
          <StatMini icon={CheckCircle2} label="Active" value={analytics.active_listings} />
          <StatMini icon={Eye} label="Total Views" value={analytics.total_views} />
          <StatMini icon={TrendingUp} label="Matches" value={analytics.total_matches} />
        </div>

        <Tabs defaultValue="listings" className="space-y-4">
          <TabsList>
            <TabsTrigger value="listings">Listings</TabsTrigger>
            <TabsTrigger value="refuel">Refuel</TabsTrigger>
          </TabsList>

          <TabsContent value="listings" className="space-y-6">
          {listings.length > 0 && listings[0].suggested_time && (
            <Card className="shadow-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" /> Best Times to List Products
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-1">
                <p>📅 Best days: <span className="font-medium text-foreground">{listings[0].suggested_time.best_days.join(", ")}</span></p>
                <p>🕐 Best hours: <span className="font-medium text-foreground">{listings[0].suggested_time.best_hours.join(" & ")}</span></p>
                <p className="text-xs mt-2 italic">{listings[0].suggested_time.tip}</p>
              </CardContent>
            </Card>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-primary" /> Your Listings
              </h2>
              <p className="text-xs text-muted-foreground">Add products via WhatsApp bot</p>
            </div>

            {listings.length === 0 ? (
              <Card className="shadow-card">
                <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <ShoppingBag className="h-10 w-10 mb-3 opacity-40" />
                  <p className="text-sm font-medium">No listings yet</p>
                  <p className="text-xs mt-1">Send a product to our WhatsApp bot to get started</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {listings.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} onMarkSold={handleMarkSold} markingSold={markingSold} />
                ))}
              </div>
            )}
          </div>
          </TabsContent>

          <TabsContent value="refuel">
            {data.referral ? (
              <ReferralTab referral={data.referral} onRefresh={fetchData} />
            ) : (
              <Card className="shadow-card">
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Referral program is not available right now.
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>

      </main>
    </div>
  );
};

const StatMini = ({ icon: Icon, label, value }: { icon: any; label: string; value: number }) => (
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

const ListingCard = ({ listing, onMarkSold, markingSold }: { listing: Listing; onMarkSold: (id: string) => void; markingSold: string | null }) => {
  const image = listing.images && listing.images.length > 0 ? listing.images[0] : null;
  const daysAgo = Math.floor((Date.now() - new Date(listing.created_at).getTime()) / (1000 * 60 * 60 * 24));

  return (
    <Card className="shadow-card overflow-hidden">
      <div className="flex gap-4 p-4">
        {image ? (
          <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
            <img src={image} alt={listing.title} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
            <ShoppingBag className="h-8 w-8 text-muted-foreground/40" />
          </div>
        )}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground truncate">{listing.title}</h3>
            <Badge variant="outline" className={`text-[10px] flex-shrink-0 ${statusColors[listing.status] || ""}`}>
              {listing.status}
            </Badge>
          </div>
          <p className="text-sm font-bold text-primary">LKR {listing.price.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{listing.city}, {listing.district} · {listing.condition}</p>
          <div className="flex items-center gap-4 pt-1">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="h-3 w-3" /> {listing.views_count} views
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <TrendingUp className="h-3 w-3" /> {listing.match_count} matches
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="h-3 w-3" /> {listing.inquiry_count} inquiries
            </span>
            <span className="text-xs text-muted-foreground ml-auto">
              {daysAgo === 0 ? "Today" : `${daysAgo}d ago`}
            </span>
          </div>
          {listing.status === "active" && (
            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                disabled={markingSold === listing.id}
                onClick={() => onMarkSold(listing.id)}
              >
                {markingSold === listing.id ? (
                  <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Updating...</>
                ) : (
                  <><CheckCircle2 className="h-3 w-3 mr-1" /> Mark as Sold</>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

export default SellerDashboard;
