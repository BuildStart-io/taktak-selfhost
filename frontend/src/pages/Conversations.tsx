import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MessageSquare, ArrowDownLeft, ArrowUpRight, Search, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChatMessage {
  id: string;
  phone_number: string;
  direction: string;
  message_text: string | null;
  intent: string | null;
  created_at: string;
}

interface Contact {
  phone_number: string;
  last_message: string | null;
  last_time: string;
  unread: number;
}

const timeAgo = (date: string) => {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

const sortByCreatedAt = (a: ChatMessage, b: ChatMessage) => {
  const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
  return aTime - bTime;
};

const upsertMessages = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const merged = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => {
    merged.set(message.id, message);
  });
  return Array.from(merged.values()).sort(sortByCreatedAt);
};

const Conversations = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let isActive = true;

    const fetchMessages = async () => {
      const { data, error } = await supabase
        .from("chat_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);

      if (!isActive) return;

      if (error) {
        console.error("Failed to fetch chat messages:", error);
        setLoading(false);
        return;
      }

      setMessages((prev) => upsertMessages(prev, (data as ChatMessage[]) || []));
      setLoading(false);
    };

    fetchMessages();

    // Subscribe to new messages in realtime
    const channel = supabase
      .channel("chat_messages_realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_messages" },
        (payload) => {
          setMessages((prev) => upsertMessages(prev, [payload.new as ChatMessage]));
        }
      )
      .subscribe();

    return () => {
      isActive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const contacts = useMemo(() => {
    const map = new Map<string, Contact>();
    // Messages are sorted ascending, so last one processed = latest
    messages.forEach((msg) => {
      const existing = map.get(msg.phone_number);
      if (!existing || new Date(msg.created_at) > new Date(existing.last_time)) {
        map.set(msg.phone_number, {
          phone_number: msg.phone_number,
          last_message: msg.message_text,
          last_time: msg.created_at,
          unread: 0,
        });
      }
    });
    // Sort by latest message
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.last_time).getTime() - new Date(a.last_time).getTime()
    );
  }, [messages]);

  const filteredContacts = useMemo(() => {
    if (!searchQuery) return contacts;
    return contacts.filter((c) =>
      c.phone_number.includes(searchQuery)
    );
  }, [contacts, searchQuery]);

  const selectedMessages = useMemo(() => {
    if (!selectedPhone) return [];
    return messages.filter((m) => m.phone_number === selectedPhone);
  }, [messages, selectedPhone]);

  // Auto-select first contact
  useEffect(() => {
    if (!selectedPhone && contacts.length > 0) {
      setSelectedPhone(contacts[0].phone_number);
    }
  }, [contacts, selectedPhone]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Conversations</h1>
        <p className="text-sm text-muted-foreground mt-1">WhatsApp chat history and live messages</p>
      </div>

      <div className="flex rounded-xl border border-border bg-card shadow-card overflow-hidden animate-fade-in" style={{ height: "calc(100vh - 180px)" }}>
        {/* Left: Contacts List */}
        <div className="w-80 border-r border-border flex flex-col shrink-0">
          <div className="p-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search chats..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent mr-2" />
                Loading...
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
                <p className="text-sm">No conversations</p>
              </div>
            ) : (
              filteredContacts.map((contact) => (
                <button
                  key={contact.phone_number}
                  onClick={() => setSelectedPhone(contact.phone_number)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-border/50 ${
                    selectedPhone === contact.phone_number
                      ? "bg-primary/10"
                      : "hover:bg-muted/40"
                  }`}
                >
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <User className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-card-foreground truncate">
                        {contact.phone_number}
                      </span>
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-2">
                        {timeAgo(contact.last_time)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {contact.last_message || "—"}
                    </p>
                  </div>
                </button>
              ))
            )}
          </ScrollArea>
        </div>

        {/* Right: Chat Area */}
        <div className="flex-1 flex flex-col">
          {selectedPhone ? (
            <>
              {/* Chat Header */}
              <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
                <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                  <User className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-card-foreground">{selectedPhone}</p>
                </div>
              </div>

              {/* Messages */}
              <ScrollArea className="flex-1 px-6 py-4">
                <div className="space-y-3">
                  {selectedMessages.map((msg) => {
                    const isIncoming = msg.direction === "incoming";
                    return (
                      <div
                        key={msg.id}
                        className={`flex ${isIncoming ? "justify-start" : "justify-end"}`}
                      >
                        <div
                          className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                            isIncoming
                              ? "bg-muted text-card-foreground rounded-bl-md"
                              : "bg-primary text-primary-foreground rounded-br-md"
                          }`}
                        >
                          <p className="text-sm whitespace-pre-wrap">
                            {msg.message_text || "—"}
                          </p>
                          <p
                            className={`text-[10px] mt-1 ${
                              isIncoming ? "text-muted-foreground" : "text-primary-foreground/70"
                            }`}
                          >
                            {new Date(msg.created_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <MessageSquare className="h-12 w-12 mb-3 opacity-30" />
              <p className="text-sm">Select a conversation to view messages</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Conversations;
