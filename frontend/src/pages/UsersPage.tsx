import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Users, Shield, Star } from "lucide-react";

interface MarketplaceUser {
  id: string;
  phone_number: string;
  display_name: string | null;
  user_type: string;
  district: string | null;
  city: string | null;
  is_verified: boolean;
  trust_score: number;
  successful_sales: number;
  is_flagged: boolean;
  created_at: string;
}

const UsersPage = () => {
  const [users, setUsers] = useState<MarketplaceUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      const { data } = await supabase
        .from("marketplace_users")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      setUsers((data as MarketplaceUser[]) || []);
      setLoading(false);
    };
    fetchUsers();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage marketplace buyers and sellers</p>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-card overflow-hidden animate-fade-in">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent mr-2" />
            Loading users...
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Users className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">No users yet</p>
            <p className="text-xs mt-1">Users will appear when they message on WhatsApp</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Phone</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Location</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Trust</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Sales</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-6 py-3">
                      <p className="text-sm font-medium text-card-foreground">{user.phone_number}</p>
                      <p className="text-xs text-muted-foreground">{user.display_name || "—"}</p>
                    </td>
                    <td className="px-6 py-3">
                      <Badge variant="outline" className="text-xs">{user.user_type}</Badge>
                    </td>
                    <td className="px-6 py-3 text-sm text-muted-foreground">
                      {user.city || user.district || "—"}
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-1">
                        <Star className="h-3 w-3 text-warning" />
                        <span className="text-sm text-card-foreground">{user.trust_score}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3 text-sm text-muted-foreground">{user.successful_sales}</td>
                    <td className="px-6 py-3">
                      {user.is_flagged ? (
                        <Badge variant="destructive" className="text-xs">Flagged</Badge>
                      ) : user.is_verified ? (
                        <Badge className="bg-success/10 text-success border-success/20 text-xs">
                          <Shield className="h-3 w-3 mr-1" />Verified
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Active</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default UsersPage;
