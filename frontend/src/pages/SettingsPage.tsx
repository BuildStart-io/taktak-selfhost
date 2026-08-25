import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Link, Copy, Check, Wifi, WifiOff, QrCode, Plus, Trash2,
  RefreshCw, Loader2, ShoppingBag, ShoppingCart, MessageSquare, Save, Bell, BellOff
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "@/integrations/supabase/client";
import WahaSessionsSection from "@/components/settings/WahaSessionsSection";
import ListingFeeSection from "@/components/settings/ListingFeeSection";
import ReferralSettingsSection from "@/components/settings/ReferralSettingsSection";
import PaymentFollowupSection from "@/components/settings/PaymentFollowupSection";
import AbandonedFollowupSection from "@/components/settings/AbandonedFollowupSection";

interface WasenderSession {
  id: number;
  name: string;
  phone_number: string | null;
  status: string;
}

interface BotModeSettings {
  mode: "off" | "seller_first" | "buyer_first";
  seller_first_message: string;
  buyer_first_message: string;
}

const SettingsPage = () => {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [sessions, setSessions] = useState<WasenderSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrSessionId, setQrSessionId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const [botMode, setBotMode] = useState<BotModeSettings>({
    mode: "off",
    seller_first_message: "",
    buyer_first_message: "",
  });
  const [botModeLoading, setBotModeLoading] = useState(true);
  const [savingMode, setSavingMode] = useState(false);

  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [notifLoading, setNotifLoading] = useState(true);
  const [savingNotif, setSavingNotif] = useState(false);

  const webhookUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wasender-webhook-taktak`;

  const copyWebhookUrl = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    toast({ title: "Copied!", description: "Webhook URL copied to clipboard" });
    setTimeout(() => setCopied(false), 2000);
  };

  const callSessionApi = async (action: string, method: string, params?: Record<string, string>, body?: any) => {
    const queryParams = new URLSearchParams({ action, ...params });
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wasender-sessions-taktak?${queryParams}`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callSessionApi("list", "GET");
      if (data?.data) {
        setSessions(Array.isArray(data.data) ? data.data : data.data.data || []);
      }
    } catch (e) {
      console.error("Failed to fetch sessions:", e);
    }
    setLoading(false);
  }, []);

  const fetchBotMode = useCallback(async () => {
    setBotModeLoading(true);
    try {
      const { data } = await supabase
        .from("bot_settings")
        .select("value")
        .eq("key", "bot_mode")
        .single();
      if (data?.value) {
        setBotMode(data.value as unknown as BotModeSettings);
      }
    } catch (e) {
      console.error("Failed to fetch bot mode:", e);
    }
    setBotModeLoading(false);
  }, []);

  const fetchNotifSetting = useCallback(async () => {
    setNotifLoading(true);
    try {
      const { data } = await supabase
        .from("bot_settings")
        .select("value")
        .eq("key", "notifications_enabled")
        .single();
      if (data?.value) {
        setNotificationsEnabled((data.value as any).enabled !== false);
      }
    } catch (e) {
      console.error("Failed to fetch notification setting:", e);
    }
    setNotifLoading(false);
  }, []);

  useEffect(() => {
    fetchSessions();
    fetchBotMode();
    fetchNotifSetting();
  }, [fetchSessions, fetchBotMode, fetchNotifSetting]);

  const saveBotMode = async (newSettings: BotModeSettings) => {
    setSavingMode(true);
    try {
      const { error } = await supabase
        .from("bot_settings")
        .update({ value: newSettings as any, updated_at: new Date().toISOString() })
        .eq("key", "bot_mode");
      if (error) throw error;
      setBotMode(newSettings);
      toast({ title: "Saved!", description: "Bot mode settings updated" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSavingMode(false);
  };

  const toggleMode = (targetMode: "seller_first" | "buyer_first") => {
    const newMode = botMode.mode === targetMode ? "off" : targetMode;
    saveBotMode({ ...botMode, mode: newMode });
  };

  const toggleNotifications = async () => {
    setSavingNotif(true);
    const newVal = !notificationsEnabled;
    try {
      const { error } = await supabase
        .from("bot_settings")
        .update({ value: { enabled: newVal } as any, updated_at: new Date().toISOString() })
        .eq("key", "notifications_enabled");
      if (error) throw error;
      setNotificationsEnabled(newVal);
      toast({ title: newVal ? "Notifications enabled" : "Notifications disabled", description: newVal ? "Bot will send product notifications to subscribers" : "Bot will stop sending product notifications" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSavingNotif(false);
  };

  const createSession = async () => {
    if (!newName.trim()) {
      toast({ title: "Error", description: "Session name is required", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const data = await callSessionApi("create", "POST", {}, { name: newName.trim(), phone_number: newPhone.trim() || undefined });
      if (data?.data?.id || data?.success) {
        toast({ title: "Session created!", description: "Now connect to get QR code" });
        setNewName("");
        setNewPhone("");
        setShowCreate(false);
        await fetchSessions();
      } else {
        toast({ title: "Error", description: data?.message || data?.error || "Failed to create session", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setCreating(false);
  };

  const connectSession = async (sessionId: number) => {
    setConnecting(sessionId);
    setQrCode(null);
    setQrSessionId(sessionId);
    try {
      await callSessionApi("update-webhook", "PUT", {}, { session_id: sessionId });
      const data = await callSessionApi("connect", "POST", {}, { session_id: sessionId });
      if (data?.data?.qrCode) {
        setQrCode(data.data.qrCode);
      } else if (data?.data?.status === "connected" || data?.data?.status === "CONNECTED") {
        toast({ title: "Already connected!", description: "This session is already active" });
        setQrSessionId(null);
      } else {
        const qrData = await callSessionApi("qrcode", "GET", { session_id: String(sessionId) });
        if (qrData?.data?.qrCode) {
          setQrCode(qrData.data.qrCode);
        } else {
          toast({ title: "Waiting...", description: "QR code not ready yet. Try again in a few seconds." });
          setQrSessionId(null);
        }
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
      setQrSessionId(null);
    }
    setConnecting(null);
  };

  const refreshQr = async () => {
    if (!qrSessionId) return;
    try {
      const data = await callSessionApi("qrcode", "GET", { session_id: String(qrSessionId) });
      if (data?.data?.qrCode) {
        setQrCode(data.data.qrCode);
      }
    } catch (e) {
      console.error("QR refresh error:", e);
    }
  };

  const deleteSession = async (sessionId: number) => {
    try {
      await callSessionApi("delete", "DELETE", { session_id: String(sessionId) });
      toast({ title: "Session deleted" });
      await fetchSessions();
      if (qrSessionId === sessionId) {
        setQrCode(null);
        setQrSessionId(null);
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const statusColor = (status: string) => {
    const s = status?.toLowerCase();
    if (s === "connected") return "text-success";
    if (s === "need_scan" || s === "connecting") return "text-warning";
    return "text-muted-foreground";
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">WhatsApp session, bot mode & integration settings</p>
      </div>

      {/* Notifications Toggle */}
      <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${notificationsEnabled ? "bg-primary/15" : "bg-muted"}`}>
              {notificationsEnabled ? <Bell className="h-5 w-5 text-primary" /> : <BellOff className="h-5 w-5 text-muted-foreground" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-card-foreground">Product Notifications</h3>
              <p className="text-[11px] text-muted-foreground">
                {notificationsEnabled ? "Bot is sending product alerts to subscribed buyers" : "Product notifications are paused"}
              </p>
            </div>
          </div>
          {notifLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={notificationsEnabled}
              onCheckedChange={toggleNotifications}
              disabled={savingNotif}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground border-t border-border pt-3">
          When disabled, the bot will not send any product listing notifications to subscribed buyers. Buyer alert subscriptions will be preserved.
        </p>
      </div>

      {/* Bot Mode Settings */}
      <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-5 animate-fade-in">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">Bot Welcome Mode</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Configure the first message new users receive. Only one mode can be active at a time.
        </p>

        {botModeLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : (
          <div className="space-y-4">
            {/* Seller First Mode */}
            <div className={`rounded-lg border p-4 space-y-3 transition-colors ${botMode.mode === "seller_first" ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${botMode.mode === "seller_first" ? "bg-primary/15" : "bg-muted"}`}>
                    <ShoppingBag className={`h-4 w-4 ${botMode.mode === "seller_first" ? "text-primary" : "text-muted-foreground"}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-card-foreground">Seller First Mode</p>
                    <p className="text-[11px] text-muted-foreground">Encourage new users to list products</p>
                  </div>
                </div>
                <Switch
                  checked={botMode.mode === "seller_first"}
                  onCheckedChange={() => toggleMode("seller_first")}
                  disabled={savingMode}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Welcome message for sellers</Label>
                <Textarea
                  value={botMode.seller_first_message}
                  onChange={(e) => setBotMode({ ...botMode, seller_first_message: e.target.value })}
                  placeholder="Enter the welcome message for seller mode..."
                  className="text-sm min-h-[80px] resize-none"
                  rows={3}
                />
              </div>
            </div>

            {/* Buyer First Mode */}
            <div className={`rounded-lg border p-4 space-y-3 transition-colors ${botMode.mode === "buyer_first" ? "border-info/40 bg-info/5" : "border-border bg-muted/20"}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${botMode.mode === "buyer_first" ? "bg-info/15" : "bg-muted"}`}>
                    <ShoppingCart className={`h-4 w-4 ${botMode.mode === "buyer_first" ? "text-info" : "text-muted-foreground"}`} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-card-foreground">Buyer First Mode</p>
                    <p className="text-[11px] text-muted-foreground">Welcome new users as buyers</p>
                  </div>
                </div>
                <Switch
                  checked={botMode.mode === "buyer_first"}
                  onCheckedChange={() => toggleMode("buyer_first")}
                  disabled={savingMode}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Welcome message for buyers</Label>
                <Textarea
                  value={botMode.buyer_first_message}
                  onChange={(e) => setBotMode({ ...botMode, buyer_first_message: e.target.value })}
                  placeholder="Enter the welcome message for buyer mode..."
                  className="text-sm min-h-[80px] resize-none"
                  rows={3}
                />
              </div>
            </div>

            <Button size="sm" onClick={() => saveBotMode(botMode)} disabled={savingMode} className="w-full">
              {savingMode ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
              Save Messages
            </Button>
          </div>
        )}
      </div>

      {/* WhatsApp Sessions */}
      <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-card-foreground">WhatsApp Sessions</h3>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchSessions} disabled={loading}>
              <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
              <Plus className="h-3 w-3 mr-1" /> New Session
            </Button>
          </div>
        </div>

        {showCreate && (
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="session-name" className="text-xs">Session Name *</Label>
              <Input id="session-name" placeholder="e.g. Business WhatsApp" value={newName} onChange={(e) => setNewName(e.target.value)} className="text-sm" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="session-phone" className="text-xs">WhatsApp Number (optional)</Label>
              <Input id="session-phone" placeholder="e.g. +94771234567" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} className="text-sm" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={createSession} disabled={creating}>
                {creating && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Create & Connect
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading sessions...
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <WifiOff className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No sessions found</p>
            <p className="text-xs mt-1">Create a new session to connect your WhatsApp</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {sessions.map((session) => (
              <div key={session.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors">
                <div>
                  <p className="text-sm font-medium text-card-foreground">{session.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {session.phone_number && <span className="text-xs text-muted-foreground">{session.phone_number}</span>}
                    <span className={`text-xs font-medium ${statusColor(session.status)}`}>{session.status}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" onClick={() => connectSession(session.id)} disabled={connecting === session.id}>
                    {connecting === session.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <QrCode className="h-3 w-3" />}
                    <span className="ml-1 text-xs">Connect</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => deleteSession(session.id)} className="text-destructive hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {qrCode && qrSessionId && (
          <div className="rounded-lg border border-border bg-background p-6 flex flex-col items-center gap-4">
            <p className="text-sm font-medium text-card-foreground">Scan this QR code with WhatsApp</p>
            <div className="bg-white p-4 rounded-xl">
              <QRCodeSVG value={qrCode} size={220} />
            </div>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Open WhatsApp → Settings → Linked Devices → Link a Device → Scan this code
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={refreshQr}>
                <RefreshCw className="h-3 w-3 mr-1" /> Refresh QR
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setQrCode(null); setQrSessionId(null); }}>Close</Button>
            </div>
          </div>
        )}
      </div>

      {/* Webhook URL */}
      <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-4 animate-fade-in">
        <div className="flex items-center gap-2">
          <Link className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">Webhook URL</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          This URL is automatically configured. Enable the <strong>messages.received</strong> event in your Wasender session webhook settings.
        </p>
        <div className="flex gap-2">
          <Input readOnly value={webhookUrl} className="font-mono text-xs" />
          <Button variant="outline" size="icon" onClick={copyWebhookUrl}>
            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {/* Payment Follow-up */}
      <ListingFeeSection />

      <ReferralSettingsSection />

      <PaymentFollowupSection />

      {/* Abandoned User Follow-up */}
      <AbandonedFollowupSection />



      {/* WAHA Sessions */}
      <WahaSessionsSection />
    </div>
  );
};

export default SettingsPage;
