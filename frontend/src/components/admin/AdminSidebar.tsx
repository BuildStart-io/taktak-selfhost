import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ShoppingBag,
  Users,
  MessageSquare,
  BarChart3,
  DollarSign,
  Receipt,
  Settings,
  Gift,
} from "lucide-react";
import taktakLogo from "@/assets/taktak-logo.png";

const navItems = [
  { icon: LayoutDashboard, label: "Overview", path: "/superadmin/dashboard" },
  { icon: ShoppingBag, label: "Listings", path: "/superadmin/listings" },
  { icon: Users, label: "Users", path: "/superadmin/users" },
  { icon: MessageSquare, label: "Conversations", path: "/superadmin/conversations" },
  { icon: BarChart3, label: "Analytics", path: "/superadmin/analytics" },
  { icon: DollarSign, label: "Revenue", path: "/superadmin/revenue" },
  { icon: Receipt, label: "Bank Slips", path: "/superadmin/bank-slips" },
  { icon: Gift, label: "Referrals", path: "/superadmin/referrals" },
  { icon: Settings, label: "Settings", path: "/superadmin/settings" },
];

const AdminSidebar = () => {
  const location = useLocation();

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-64 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-6">
        <img src={taktakLogo} alt="TakTak" className="h-9 w-auto" />
        <div>
          <h1 className="text-base font-bold text-sidebar-foreground">TakTak</h1>
          <p className="text-[11px] text-muted-foreground">Admin Dashboard</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-primary"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-2 rounded-lg bg-accent/50 px-3 py-2">
          <div className="h-2 w-2 rounded-full bg-success animate-pulse-soft" />
          <span className="text-xs text-muted-foreground">WhatsApp Connected</span>
        </div>
      </div>
    </aside>
  );
};

export default AdminSidebar;
