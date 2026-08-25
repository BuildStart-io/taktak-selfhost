import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, PauseCircle, PlayCircle, ShoppingBag, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Listing {
  id: string;
  title: string;
  price: number;
  city: string;
  district: string;
  status: string;
  condition: string;
  category: string | null;
  views_count: number;
  created_at: string;
  payment_status: string | null;
  paid_at: string | null;
  listing_fee: number | null;
  additional_details: Record<string, any> | null;
  marketplace_users?: { phone_number: string | null } | null;
}

const statusColors: Record<string, string> = {
  active: "bg-success/10 text-success border-success/20",
  sold: "bg-info/10 text-info border-info/20",
  expired: "bg-muted text-muted-foreground border-border",
  removed: "bg-destructive/10 text-destructive border-destructive/20",
  pending: "bg-warning/10 text-warning border-warning/20",
  pending_payment: "bg-warning/10 text-warning border-warning/20",
};

const ListingsTable = () => {
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchListings = async () => {
    let allListings: Listing[] = [];
    let from = 0;
    const pageSize = 1000;
    let keepFetching = true;
    while (keepFetching) {
      const { data } = await supabase
        .from("listings")
        .select("*, marketplace_users!listings_seller_id_fkey(phone_number)")
        .order("created_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (data && data.length > 0) {
        allListings = [...allListings, ...(data as Listing[])];
        from += pageSize;
        if (data.length < pageSize) keepFetching = false;
      } else {
        keepFetching = false;
      }
    }
    setListings(allListings);
    setLoading(false);
  };

  useEffect(() => { fetchListings(); }, []);

  const handleDelete = async (listingId: string) => {
    setDeleting(listingId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: "Error", description: "Not authenticated", variant: "destructive" });
        setDeleting(null);
        return;
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-listing-taktak`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ listing_id: listingId }),
        }
      );
      const result = await res.json();
      if (result.success) {
        setListings((prev) => prev.filter((l) => l.id !== listingId));
        toast({ title: "Deleted", description: "Listing and related data removed." });
      } else {
        toast({ title: "Error", description: result.error || "Failed to delete", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to delete listing", variant: "destructive" });
    }
    setDeleting(null);
  };

  const handleListingAction = async (listingId: string, action: "approve_payment" | "pause_listing" | "activate_listing") => {
    setActing(`${action}:${listingId}`);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: "Error", description: "Not authenticated", variant: "destructive" });
        return;
      }

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-listing-action-taktak`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ listing_id: listingId, action }),
        }
      );
      const result = await res.json();
      if (!res.ok || !result.success) {
        throw new Error(result.error || "Action failed");
      }

      const label = action === "approve_payment" ? "Payment approved" : action === "pause_listing" ? "Listing paused" : "Listing activated";
      toast({
        title: label,
        description: result.whatsapp_sent === false ? "Saved, but WhatsApp message was not delivered." : "Seller was notified on WhatsApp.",
        variant: result.whatsapp_sent === false ? "destructive" : "default",
      });
      await fetchListings();
    } catch (e: any) {
      toast({ title: "Error", description: e.message || "Action failed", variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const isActing = (listingId: string, action: string) => acting === `${action}:${listingId}`;

  const pendingCount = listings.filter((l) => l.status === "pending_payment").length;
  const pausedCount = listings.filter((l) => l.status === "pending" && l.payment_status === "paid").length;
  const activeCount = listings.filter((l) => l.status === "active").length;

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 shadow-card">
        <div className="flex items-center justify-center text-muted-foreground">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent mr-2" />
          Loading listings...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-card animate-fade-in overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-6 py-4">
        <ShoppingBag className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-card-foreground">Recent Listings</h3>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{listings.length} listings</span>
          <Badge variant="outline" className="border-warning/20 text-warning">{pendingCount} pending payments</Badge>
          <Badge variant="outline" className="border-success/20 text-success">{activeCount} live</Badge>
          <Badge variant="outline" className="border-border text-muted-foreground">{pausedCount} paused</Badge>
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <ShoppingBag className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm">No listings yet</p>
          <p className="text-xs mt-1">Listings created via WhatsApp will appear here</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Product</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Price</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Location</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Seller</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Views</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Listed</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {listings.map((listing) => (
                <tr key={listing.id} className="hover:bg-muted/20 transition-colors">
                  <td className="px-6 py-3">
                    <p className="text-sm font-medium text-card-foreground">{listing.title}</p>
                    <p className="text-xs text-muted-foreground">{listing.category || listing.condition}</p>
                    {listing.additional_details && Object.keys(listing.additional_details).length > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {Object.entries(listing.additional_details)
                          .filter(([_, v]) => v && v !== "N/A")
                          .slice(0, 3)
                          .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                          .join(" · ")}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm font-semibold text-card-foreground">
                    LKR {listing.price?.toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-sm text-muted-foreground">
                    {listing.city}, {listing.district}
                  </td>
                  <td className="px-6 py-3 text-sm text-muted-foreground whitespace-nowrap">
                    {listing.marketplace_users?.phone_number ? `+${listing.marketplace_users.phone_number}` : "—"}
                  </td>
                  <td className="px-6 py-3">
                    <Badge variant="outline" className={statusColors[listing.status] || ""}>
                      {listing.status === "pending" && listing.payment_status === "paid" ? "paused" : listing.status.replace("_", " ")}
                    </Badge>
                    {listing.payment_status && (
                      <p className="mt-1 text-[11px] text-muted-foreground">Payment: {listing.payment_status}</p>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-muted-foreground">{listing.views_count}</td>
                  <td className="px-6 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(listing.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </td>
                  <td className="px-6 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                    {listing.status === "pending_payment" && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 text-xs"
                            disabled={Boolean(acting)}
                          >
                            {isActing(listing.id, "approve_payment") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            Approve
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Approve manual bank payment?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will mark "{listing.title}" as paid, make it live, record revenue, and send the seller a WhatsApp verification message.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleListingAction(listing.id, "approve_payment")}>
                              Approve payment
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}

                    {listing.status === "active" && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" disabled={Boolean(acting)}>
                            {isActing(listing.id, "pause_listing") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="h-3.5 w-3.5" />}
                            Pause
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Pause this listing?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes "{listing.title}" from buyer search results while keeping its payment marked as paid.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleListingAction(listing.id, "pause_listing")}>
                              Pause listing
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}

                    {listing.status === "pending" && listing.payment_status === "paid" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 text-xs"
                        disabled={Boolean(acting)}
                        onClick={() => handleListingAction(listing.id, "activate_listing")}
                      >
                        {isActing(listing.id, "activate_listing") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
                        Resume
                      </Button>
                    )}

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          disabled={deleting === listing.id}
                        >
                          {deleting === listing.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete listing?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete "{listing.title}" and remove it from all search results, seller dashboards, and related leads. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDelete(listing.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ListingsTable;
