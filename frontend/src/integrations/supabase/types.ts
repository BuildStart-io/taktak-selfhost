export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      bot_settings: {
        Row: {
          id: string
          key: string
          updated_at: string | null
          value: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string | null
          value?: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string | null
          value?: Json
        }
        Relationships: []
      }
      buyer_alerts: {
        Row: {
          category: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          is_premium: boolean | null
          last_notified_at: string | null
          location: string | null
          max_price: number | null
          product_keyword: string | null
          search_query: string
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          last_notified_at?: string | null
          location?: string | null
          max_price?: number | null
          product_keyword?: string | null
          search_query: string
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          last_notified_at?: string | null
          location?: string | null
          max_price?: number | null
          product_keyword?: string | null
          search_query?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_alerts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          created_at: string | null
          direction: string
          id: string
          intent: Database["public"]["Enums"]["chat_intent"] | null
          message_text: string | null
          message_type: string | null
          metadata: Json | null
          phone_number: string
          session_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          direction: string
          id?: string
          intent?: Database["public"]["Enums"]["chat_intent"] | null
          message_text?: string | null
          message_type?: string | null
          metadata?: Json | null
          phone_number: string
          session_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          direction?: string
          id?: string
          intent?: Database["public"]["Enums"]["chat_intent"] | null
          message_text?: string | null
          message_type?: string | null
          metadata?: Json | null
          phone_number?: string
          session_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          buyer_id: string | null
          created_at: string | null
          id: string
          listing_id: string | null
          seller_id: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          buyer_id?: string | null
          created_at?: string | null
          id?: string
          listing_id?: string | null
          seller_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          buyer_id?: string | null
          created_at?: string | null
          id?: string
          listing_id?: string | null
          seller_id?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_buyer_id_fkey"
            columns: ["buyer_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      listings: {
        Row: {
          additional_details: Json | null
          boost_expires_at: string | null
          category: string | null
          city: string
          condition: Database["public"]["Enums"]["product_condition"] | null
          created_at: string | null
          description: string | null
          district: string
          expires_at: string | null
          id: string
          images: string[] | null
          is_boosted: boolean | null
          is_sponsored: boolean | null
          listing_fee: number | null
          match_count: number | null
          paid_at: string | null
          payment_followup_sent_at: string | null
          payment_reference: string | null
          payment_status: string | null
          price: number
          seller_id: string
          status: Database["public"]["Enums"]["listing_status"] | null
          title: string
          updated_at: string | null
          views_count: number | null
        }
        Insert: {
          additional_details?: Json | null
          boost_expires_at?: string | null
          category?: string | null
          city: string
          condition?: Database["public"]["Enums"]["product_condition"] | null
          created_at?: string | null
          description?: string | null
          district: string
          expires_at?: string | null
          id?: string
          images?: string[] | null
          is_boosted?: boolean | null
          is_sponsored?: boolean | null
          listing_fee?: number | null
          match_count?: number | null
          paid_at?: string | null
          payment_followup_sent_at?: string | null
          payment_reference?: string | null
          payment_status?: string | null
          price: number
          seller_id: string
          status?: Database["public"]["Enums"]["listing_status"] | null
          title: string
          updated_at?: string | null
          views_count?: number | null
        }
        Update: {
          additional_details?: Json | null
          boost_expires_at?: string | null
          category?: string | null
          city?: string
          condition?: Database["public"]["Enums"]["product_condition"] | null
          created_at?: string | null
          description?: string | null
          district?: string
          expires_at?: string | null
          id?: string
          images?: string[] | null
          is_boosted?: boolean | null
          is_sponsored?: boolean | null
          listing_fee?: number | null
          match_count?: number | null
          paid_at?: string | null
          payment_followup_sent_at?: string | null
          payment_reference?: string | null
          payment_status?: string | null
          price?: number
          seller_id?: string
          status?: Database["public"]["Enums"]["listing_status"] | null
          title?: string
          updated_at?: string | null
          views_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "listings_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      marketplace_users: {
        Row: {
          bot_state: Json
          city: string | null
          created_at: string | null
          display_name: string | null
          district: string | null
          flag_reason: string | null
          id: string
          is_flagged: boolean | null
          is_verified: boolean | null
          payout_account: Json | null
          phone_number: string
          preferred_language: string | null
          referral_code: string | null
          subscription_type: string | null
          successful_purchases: number | null
          successful_sales: number | null
          trust_score: number | null
          updated_at: string | null
          user_type: Database["public"]["Enums"]["user_type"] | null
        }
        Insert: {
          bot_state?: Json
          city?: string | null
          created_at?: string | null
          display_name?: string | null
          district?: string | null
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean | null
          is_verified?: boolean | null
          payout_account?: Json | null
          phone_number: string
          preferred_language?: string | null
          referral_code?: string | null
          subscription_type?: string | null
          successful_purchases?: number | null
          successful_sales?: number | null
          trust_score?: number | null
          updated_at?: string | null
          user_type?: Database["public"]["Enums"]["user_type"] | null
        }
        Update: {
          bot_state?: Json
          city?: string | null
          created_at?: string | null
          display_name?: string | null
          district?: string | null
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean | null
          is_verified?: boolean | null
          payout_account?: Json | null
          phone_number?: string
          preferred_language?: string | null
          referral_code?: string | null
          subscription_type?: string | null
          successful_purchases?: number | null
          successful_sales?: number | null
          trust_score?: number | null
          updated_at?: string | null
          user_type?: Database["public"]["Enums"]["user_type"] | null
        }
        Relationships: []
      }
      notification_log: {
        Row: {
          alert_id: string | null
          id: string
          listing_id: string | null
          phone_number: string
          sent_at: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          alert_id?: string | null
          id?: string
          listing_id?: string | null
          phone_number: string
          sent_at?: string | null
          status?: string | null
          user_id: string
        }
        Update: {
          alert_id?: string | null
          id?: string
          listing_id?: string | null
          phone_number?: string
          sent_at?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_log_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "buyer_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_log_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          currency: string
          gateway_response: Json | null
          id: string
          listing_id: string | null
          phone_number: string | null
          provider: string
          provider_transaction_id: string | null
          redirect_url: string | null
          reference: string
          seller_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          gateway_response?: Json | null
          id?: string
          listing_id?: string | null
          phone_number?: string | null
          provider?: string
          provider_transaction_id?: string | null
          redirect_url?: string | null
          reference: string
          seller_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          gateway_response?: Json | null
          id?: string
          listing_id?: string | null
          phone_number?: string | null
          provider?: string
          provider_transaction_id?: string | null
          redirect_url?: string | null
          reference?: string
          seller_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_broadcast_log: {
        Row: {
          error: string | null
          id: string
          phone_number: string
          sent_at: string
          status: string
          user_id: string | null
        }
        Insert: {
          error?: string | null
          id?: string
          phone_number: string
          sent_at?: string
          status?: string
          user_id?: string | null
        }
        Update: {
          error?: string | null
          id?: string
          phone_number?: string
          sent_at?: string
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "referral_broadcast_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_payouts: {
        Row: {
          account_snapshot: Json
          admin_note: string | null
          amount: number
          created_at: string
          id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_snapshot?: Json
          admin_note?: string | null
          amount: number
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          account_snapshot?: Json
          admin_note?: string | null
          amount?: number
          created_at?: string
          id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_payouts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_rewards: {
        Row: {
          amount: number
          created_at: string
          description: string | null
          id: string
          listing_id: string | null
          referred_id: string | null
          referrer_id: string
          reward_type: string
        }
        Insert: {
          amount?: number
          created_at?: string
          description?: string | null
          id?: string
          listing_id?: string | null
          referred_id?: string | null
          referrer_id: string
          reward_type: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string | null
          id?: string
          listing_id?: string | null
          referred_id?: string | null
          referrer_id?: string
          reward_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_rewards_listing_id_fkey"
            columns: ["listing_id"]
            isOneToOne: false
            referencedRelation: "listings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_rewards_referred_id_fkey"
            columns: ["referred_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_rewards_referrer_id_fkey"
            columns: ["referrer_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          code: string
          created_at: string
          id: string
          referred_id: string
          referred_phone: string
          referrer_id: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          referred_id: string
          referred_phone: string
          referrer_id: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          referred_id?: string
          referred_phone?: string
          referrer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referrals_referred_id_fkey"
            columns: ["referred_id"]
            isOneToOne: true
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_referrer_id_fkey"
            columns: ["referrer_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      revenue: {
        Row: {
          amount: number
          created_at: string | null
          description: string | null
          id: string
          type: string
          user_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          description?: string | null
          id?: string
          type: string
          user_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          description?: string | null
          id?: string
          type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "revenue_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      search_history: {
        Row: {
          created_at: string | null
          detected_category: string | null
          detected_intent: Database["public"]["Enums"]["chat_intent"] | null
          detected_location: string | null
          detected_product: string | null
          filters: Json | null
          id: string
          query_text: string
          results_count: number | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          detected_category?: string | null
          detected_intent?: Database["public"]["Enums"]["chat_intent"] | null
          detected_location?: string | null
          detected_product?: string | null
          filters?: Json | null
          id?: string
          query_text: string
          results_count?: number | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          detected_category?: string | null
          detected_intent?: Database["public"]["Enums"]["chat_intent"] | null
          detected_location?: string | null
          detected_product?: string | null
          filters?: Json | null
          id?: string
          query_text?: string
          results_count?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "search_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "marketplace_users"
            referencedColumns: ["id"]
          },
        ]
      }
      seller_otp_log: {
        Row: {
          chat_id: string | null
          created_at: string
          error: string | null
          http_status: number | null
          id: string
          otp_id: string | null
          phone_number: string
          provider: string | null
          status: string
        }
        Insert: {
          chat_id?: string | null
          created_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          otp_id?: string | null
          phone_number: string
          provider?: string | null
          status: string
        }
        Update: {
          chat_id?: string | null
          created_at?: string
          error?: string | null
          http_status?: number | null
          id?: string
          otp_id?: string | null
          phone_number?: string
          provider?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "seller_otp_log_otp_id_fkey"
            columns: ["otp_id"]
            isOneToOne: false
            referencedRelation: "seller_otps"
            referencedColumns: ["id"]
          },
        ]
      }
      seller_otps: {
        Row: {
          created_at: string | null
          expires_at: string
          id: string
          otp_code: string
          phone_number: string
          used: boolean | null
        }
        Insert: {
          created_at?: string | null
          expires_at: string
          id?: string
          otp_code: string
          phone_number: string
          used?: boolean | null
        }
        Update: {
          created_at?: string | null
          expires_at?: string
          id?: string
          otp_code?: string
          phone_number?: string
          used?: boolean | null
        }
        Relationships: []
      }
      seller_sessions: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          phone_number: string
          session_token: string
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          phone_number: string
          session_token: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          phone_number?: string
          session_token?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      waha_sessions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
          phone_number: string | null
          role: string
          status: string
          updated_at: string
          waha_session_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          phone_number?: string | null
          role?: string
          status?: string
          updated_at?: string
          waha_session_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          phone_number?: string | null
          role?: string
          status?: string
          updated_at?: string
          waha_session_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      chat_intent:
        | "buy"
        | "sell"
        | "search"
        | "negotiate"
        | "check_availability"
        | "greeting"
        | "unknown"
      listing_status:
        | "active"
        | "sold"
        | "expired"
        | "removed"
        | "pending"
        | "pending_payment"
      product_condition: "new" | "like_new" | "good" | "fair" | "poor"
      user_type: "buyer" | "seller" | "both"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      chat_intent: [
        "buy",
        "sell",
        "search",
        "negotiate",
        "check_availability",
        "greeting",
        "unknown",
      ],
      listing_status: [
        "active",
        "sold",
        "expired",
        "removed",
        "pending",
        "pending_payment",
      ],
      product_condition: ["new", "like_new", "good", "fair", "poor"],
      user_type: ["buyer", "seller", "both"],
    },
  },
} as const
