import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AdminLayout from "@/layouts/AdminLayout";
import AdminProtectedRoute from "@/components/AdminProtectedRoute";
import Referrals from "./pages/Referrals";
import Index from "./pages/Index";
import Listings from "./pages/Listings";
import UsersPage from "./pages/UsersPage";
import Conversations from "./pages/Conversations";
import Analytics from "./pages/Analytics";
import Revenue from "./pages/Revenue";
import BankSlips from "./pages/BankSlips";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";
import SuperAdminLogin from "./pages/SuperAdminLogin";
import SellerLogin from "./pages/SellerLogin";
import SellerDashboard from "./pages/SellerDashboard";
import PaymentSuccess from "./pages/PaymentSuccess";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          {/* Seller routes */}
          <Route path="/login" element={<SellerLogin />} />
          <Route path="/dashboard" element={<SellerDashboard />} />
          <Route path="/payment/success" element={<PaymentSuccess />} />

          {/* Admin login */}
          <Route path="/superadmin" element={<SuperAdminLogin />} />

          {/* Admin dashboard (protected) */}
          <Route
            element={
              <AdminProtectedRoute>
                <AdminLayout />
              </AdminProtectedRoute>
            }
          >
            <Route path="/superadmin/dashboard" element={<Index />} />
            <Route path="/superadmin/listings" element={<Listings />} />
            <Route path="/superadmin/users" element={<UsersPage />} />
            <Route path="/superadmin/conversations" element={<Conversations />} />
            <Route path="/superadmin/analytics" element={<Analytics />} />
            <Route path="/superadmin/revenue" element={<Revenue />} />
            <Route path="/superadmin/bank-slips" element={<BankSlips />} />
            <Route path="/superadmin/referrals" element={<Referrals />} />
          <Route path="/superadmin/settings" element={<SettingsPage />} />
          </Route>

          {/* Root redirect to seller login */}
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
