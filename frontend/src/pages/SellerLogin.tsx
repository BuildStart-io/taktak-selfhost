import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { ArrowRight, Loader2, MessageCircle, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import taktakLogo from "@/assets/taktak-logo.png";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const WHATSAPP_BOT_NUMBER = "+94771100789";

const SellerLogin = () => {
  const [step, setStep] = useState<"phone" | "otp" | "no_listings">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const token = localStorage.getItem("seller_session_token");
    if (token) validateSession(token);
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const validateSession = async (token: string) => {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/validate-seller-session-taktak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ session_token: token }),
      });
      const data = await res.json();
      if (data.valid) {
        localStorage.setItem("seller_info", JSON.stringify(data.seller));
        navigate("/dashboard");
      }
    } catch { /* session invalid, stay on login */ }
  };

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;
    setLoading(true);
    setErrorMessage("");
    try {
      const cleanPhone = phone.replace(/\D/g, "");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-seller-otp-taktak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ phone_number: cleanPhone }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "NO_ACCOUNT" || data.code === "NO_LISTINGS") {
          setErrorMessage(data.code === "NO_ACCOUNT"
            ? "No account found for this number."
            : "No listings found for this number.");
          setStep("no_listings");
        } else {
          toast({ title: "Error", description: data.error, variant: "destructive" });
        }
      } else {
        toast({ title: "OTP Sent!", description: "Check your WhatsApp for the 6-digit code." });
        setStep("otp");
        setCountdown(180);
      }
    } catch {
      toast({ title: "Error", description: "Something went wrong. Try again.", variant: "destructive" });
    }
    setLoading(false);
  };

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) return;
    setLoading(true);
    try {
      const cleanPhone = phone.replace(/\D/g, "");
      const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-seller-otp-taktak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ phone_number: cleanPhone, otp }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Invalid OTP", description: data.error, variant: "destructive" });
      } else {
        localStorage.setItem("seller_session_token", data.session_token);
        localStorage.setItem("seller_info", JSON.stringify(data.seller));
        toast({ title: "Welcome!", description: "Seller dashboard loaded." });
        navigate("/dashboard");
      }
    } catch {
      toast({ title: "Error", description: "Verification failed. Try again.", variant: "destructive" });
    }
    setLoading(false);
  };

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm shadow-elevated">
        <CardHeader className="text-center space-y-3">
          <img src={taktakLogo} alt="TakTak AI Marketplace" className="mx-auto h-20 w-auto" />
          <CardTitle className="text-xl font-bold">Seller Dashboard</CardTitle>
          <CardDescription>
            {step === "phone"
              ? "Enter your WhatsApp number to receive an OTP"
              : step === "otp"
              ? "Enter the 6-digit code sent to your WhatsApp"
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "no_listings" ? (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-8 w-8 text-destructive" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-foreground">{errorMessage}</h3>
                <p className="text-sm text-muted-foreground">
                  To access the Seller Dashboard, you need to list at least one product first. Send a message to our WhatsApp bot to get started.
                </p>
              </div>
              <a
                href={`https://wa.me/${WHATSAPP_BOT_NUMBER.replace(/\+/g, "")}?text=sell`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full"
              >
                <Button className="w-full bg-[#25D366] hover:bg-[#1da851] text-white gap-2 text-sm font-semibold">
                  <MessageCircle className="h-5 w-5" />
                  List a Product on WhatsApp
                </Button>
              </a>
              <p className="text-xs text-muted-foreground">
                Bot number: <span className="font-mono font-medium text-foreground">{WHATSAPP_BOT_NUMBER}</span>
              </p>
              <Button
                variant="ghost"
                className="w-full text-xs"
                onClick={() => { setStep("phone"); setErrorMessage(""); }}
              >
                ← Try a different number
              </Button>
            </div>
          ) : step === "phone" ? (
            <form onSubmit={handleSendOTP} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">WhatsApp Number</label>
                <Input
                  type="tel"
                  placeholder="e.g. 94771234567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">Include country code (94 for Sri Lanka)</p>
              </div>
              <Button type="submit" className="w-full gradient-primary" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ArrowRight className="h-4 w-4 mr-2" />}
                Send OTP
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-center">
                <InputOTP maxLength={6} value={otp} onChange={setOtp}>
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
              </div>
              {countdown > 0 && (
                <p className="text-center text-xs text-muted-foreground">
                  Code expires in <span className="font-semibold text-foreground">{formatTime(countdown)}</span>
                </p>
              )}
              {countdown <= 0 && (
                <Button variant="ghost" className="w-full text-sm" onClick={() => { setStep("phone"); setOtp(""); }}>
                  Code expired — Request new OTP
                </Button>
              )}
              <Button className="w-full gradient-primary" onClick={handleVerifyOTP} disabled={loading || otp.length !== 6}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Verify & Login
              </Button>
              <Button variant="ghost" className="w-full text-xs" onClick={() => { setStep("phone"); setOtp(""); setCountdown(0); }}>
                ← Change number
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default SellerLogin;
