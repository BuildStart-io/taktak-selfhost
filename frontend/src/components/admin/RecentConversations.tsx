import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MessageSquare } from "lucide-react";

interface Conversation {
  id: string;
  phone_number: string;
  message_text: string | null;
  intent: string | null;
  created_at: string;
  direction: string;
}

const intentColors: Record<string, string> = {
  search: "bg-info/10 text-info",
  buy: "bg-info/10 text-info",
  sell: "bg-success/10 text-success",
  negotiate: "bg-warning/10 text-warning",
  check_availability: "bg-primary/10 text-primary",
  greeting: "bg-muted text-muted-foreground",
};

const RecentConversations = () => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchConversations = async () => {
      const { data } = await supabase
        .from("chat_messages")
        .select("id, phone_number, message_text, intent, created_at, direction")
        .eq("direction", "incoming")
        .order("created_at", { ascending: false })
        .limit(5);
      setConversations((data as Conversation[]) || []);
      setLoading(false);
    };
    fetchConversations();
  }, []);

  const timeAgo = (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="rounded-xl border border-border bg-card shadow-card animate-fade-in">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">Recent Conversations</h3>
        </div>
        <span className="text-xs text-muted-foreground">Live</span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">Loading...</div>
      ) : conversations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
          <p className="text-sm">No conversations yet</p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {conversations.map((conv) => (
            <div key={conv.id} className="flex items-center justify-between px-6 py-3 hover:bg-muted/30 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-card-foreground truncate">{conv.phone_number}</p>
                  {conv.intent && (
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${intentColors[conv.intent] || intentColors.greeting}`}>
                      {conv.intent}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{conv.message_text || "—"}</p>
              </div>
              <span className="text-[11px] text-muted-foreground ml-3 whitespace-nowrap">{timeAgo(conv.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default RecentConversations;
