import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, RefreshCw, Loader2, Wifi, WifiOff, QrCode, Copy, Check, Link as LinkIcon,
} from "lucide-react";

interface WahaSession {
  id: string;
  name: string;
  phone_number: string | null;
  waha_session_id: string;
  status: string;
  role: string;
}

const callWaha = async (action: string, session?: string, extra: Record<string, any> = {}) => {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");
  const { data, error } = await supabase.functions.invoke("waha-control-taktak", {
    body: { action, session: session || "default", ...extra },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (error) throw error;
  return data as any;
};

const WahaSessionsSection = () => {
  const { toast } = useToast();
  const [rows, setRows] = useState<WahaSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrForId, setQrForId] = useState<string | null>(null);
  const [qrNotice, setQrNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [copied, setCopied] = useState(false);

  const webhookUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/waha-webhook-taktak`;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("waha_sessions")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Failed to load", description: error.message, variant: "destructive" });
    } else {
      setRows((data as WahaSession[]) || []);
      // Best-effort live status
      for (const r of data || []) {
        try {
          const info = await callWaha("session_info", r.waha_session_id);
          const s = String(info?.body?.status || info?.body?.session?.status || "").toLowerCase();
          const phone = info?.body?.me?.id || info?.body?.session?.me?.id || null;
          const status = s === "working" ? "connected" : s === "scan_qr_code" ? "connecting" : "disconnected";
          const phoneClean = phone ? String(phone).split("@")[0] : r.phone_number;
          if (status !== r.status || phoneClean !== r.phone_number) {
            await supabase.from("waha_sessions").update({ status, phone_number: phoneClean }).eq("id", r.id);
          }
        } catch { /* ignore */ }
      }
      const { data: fresh } = await supabase.from("waha_sessions").select("*").order("created_at", { ascending: false });
      setRows((fresh as WahaSession[]) || []);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const pollQr = async (rowId: string, sessionName: string, force = false) => {
    setQrForId(rowId);
    setQr(null);
    setQrNotice(null);
    let latestNotice = "Session has not reached QR mode yet.";
    for (let i = 0; i < 15; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000));
      try {
        const result = await callWaha(force ? "force_qr" : "qr", sessionName);
        const direct = result?.body?.qr;
        if (direct) { setQr(direct); return; }
        const status = result?.body?.status || result?.status;
        const message = result?.body?.error || result?.error;
        if (message) {
          latestNotice = `${message}${status ? ` Current status: ${status}.` : ""}`;
          setQrNotice(latestNotice);
        }
      } catch (e: any) {
        latestNotice = e?.message || "QR is not ready yet.";
        setQrNotice(latestNotice);
      }
      if (force) break;
    }
    toast({ title: "No QR available", description: latestNotice, variant: "destructive" });
  };

  const createSession = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const sessionName = newName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const { data: user } = await supabase.auth.getUser();
      const { data: inserted, error } = await supabase
        .from("waha_sessions")
        .insert({
          name: newName.trim(),
          waha_session_id: sessionName,
          status: "disconnected",
          role: "bot",
          created_by: user.user?.id,
        })
        .select()
        .single();
      if (error) throw error;
      await callWaha("start_session", sessionName);
      toast({ title: "Session created", description: "Fetching QR code..." });
      setShowCreate(false);
      setNewName("");
      await load();
      pollQr((inserted as any).id, sessionName);
    } catch (e: any) {
      toast({ title: "Create failed", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const reconnect = async (r: WahaSession) => {
    setBusy(r.id);
    try {
      await callWaha("start_session", r.waha_session_id);
      pollQr(r.id, r.waha_session_id);
    } catch (e: any) {
      toast({ title: "Reconnect failed", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const forceQr = async (r: WahaSession) => {
    if (!confirm(`Force QR for "${r.name}"? This logs out the current WhatsApp link and requires scanning again.`)) return;
    setBusy(r.id);
    try {
      await pollQr(r.id, r.waha_session_id, true);
      await load();
    } catch (e: any) {
      toast({ title: "Force QR failed", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const stop = async (r: WahaSession) => {
    setBusy(r.id);
    try { await callWaha("stop_session", r.waha_session_id); await load(); }
    catch (e: any) { toast({ title: "Stop failed", description: e.message, variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const logout = async (r: WahaSession) => {
    setBusy(r.id);
    try { await callWaha("logout_session", r.waha_session_id); await load(); }
    catch (e: any) { toast({ title: "Logout failed", description: e.message, variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const registerWebhook = async (r: WahaSession) => {
    setBusy(r.id);
    try {
      const res = await callWaha("register_bot_webhook", r.waha_session_id);
      toast({ title: "Webhook registered", description: `restarted=${res?.restarted ? "yes" : "no"}` });
    } catch (e: any) {
      toast({ title: "Register failed", description: e.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const remove = async (r: WahaSession) => {
    if (!confirm(`Delete session "${r.name}"? This does not remove it from WAHA server.`)) return;
    setBusy(r.id);
    try {
      await supabase.from("waha_sessions").delete().eq("id", r.id);
      await load();
    } finally { setBusy(null); }
  };

  const copyHook = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    toast({ title: "Copied", description: "WAHA webhook URL copied" });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-border bg-card shadow-card p-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-card-foreground">WAHA Sessions</h3>
          <p className="text-xs text-muted-foreground">Alternative WhatsApp provider (runs alongside Wasender).</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="h-3 w-3 mr-1" /> New WAHA session
          </Button>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          <Label className="text-xs">Session name</Label>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="taktak-bot" />
          <div className="flex gap-2">
            <Button size="sm" onClick={createSession} disabled={creating || !newName.trim()}>
              {creating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null} Create & get QR
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rows.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground text-center py-4">No WAHA sessions yet.</p>
        )}
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border border-border bg-background p-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {r.status === "connected"
                  ? <Wifi className="h-4 w-4 text-success" />
                  : <WifiOff className="h-4 w-4 text-muted-foreground" />}
                <p className="text-sm font-medium truncate">{r.name}</p>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{r.status}</span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {r.waha_session_id}{r.phone_number ? ` · ${r.phone_number}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-1 justify-end">
              <Button variant="outline" size="sm" onClick={() => reconnect(r)} disabled={busy === r.id}>
                <QrCode className="h-3 w-3 mr-1" /> QR
              </Button>
              <Button variant="outline" size="sm" onClick={() => forceQr(r)} disabled={busy === r.id}>
                Force QR
              </Button>
              <Button variant="outline" size="sm" onClick={() => registerWebhook(r)} disabled={busy === r.id}>
                <LinkIcon className="h-3 w-3 mr-1" /> Hook bot
              </Button>
              <Button variant="ghost" size="sm" onClick={() => stop(r)} disabled={busy === r.id}>Stop</Button>
              <Button variant="ghost" size="sm" onClick={() => logout(r)} disabled={busy === r.id}>Logout</Button>
              <Button variant="ghost" size="icon" onClick={() => remove(r)} disabled={busy === r.id}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {qrForId && (qr || qrNotice) && (
        <div className="rounded-lg border border-border bg-background p-6 flex flex-col items-center gap-3">
          {qr ? (
            <>
              <p className="text-sm font-medium">Scan with WhatsApp → Linked Devices</p>
              <img src={qr} alt="WAHA QR" className="w-56 h-56 rounded-lg bg-white p-2" />
            </>
          ) : (
            <p className="text-sm text-muted-foreground text-center max-w-md">{qrNotice}</p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setQr(null); setQrNotice(null); setQrForId(null); load(); }}>Close</Button>
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-border">
        <p className="text-xs text-muted-foreground mb-2">
          Inbound webhook (auto-registered when you click <strong>Hook bot</strong>):
        </p>
        <div className="flex gap-2">
          <Input readOnly value={webhookUrl} className="font-mono text-xs" />
          <Button variant="outline" size="icon" onClick={copyHook}>
            {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default WahaSessionsSection;
