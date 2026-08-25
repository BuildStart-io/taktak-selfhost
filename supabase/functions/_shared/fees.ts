// Single source of truth for the TakTak listing fee.
// Stored in bot_settings under key = "listing_fee" so admins can change it
// from the Superadmin dashboard without a redeploy.

export interface FeeConfig {
  /** Asking price at/above which the higher fee applies (LKR) */
  threshold: number;
  /** Fee for listings priced BELOW the threshold (LKR) */
  low: number;
  /** Fee for listings priced AT/ABOVE the threshold (LKR) */
  high: number;
}

export const DEFAULT_FEES: FeeConfig = {
  threshold: 1_000_000,
  low: 300,
  high: 500,
};

export async function getFeeConfig(supabase: any): Promise<FeeConfig> {
  try {
    const { data } = await supabase
      .from("bot_settings")
      .select("value")
      .eq("key", "listing_fee")
      .maybeSingle();
    const v = (data?.value || {}) as Partial<FeeConfig>;
    return {
      threshold: Number(v.threshold) > 0 ? Number(v.threshold) : DEFAULT_FEES.threshold,
      low: Number(v.low) > 0 ? Number(v.low) : DEFAULT_FEES.low,
      high: Number(v.high) > 0 ? Number(v.high) : DEFAULT_FEES.high,
    };
  } catch {
    return DEFAULT_FEES;
  }
}

export function feeForPrice(price: number | null | undefined, cfg: FeeConfig = DEFAULT_FEES) {
  return Number(price) >= cfg.threshold ? cfg.high : cfg.low;
}

export function money(n: number) {
  return Number(n).toLocaleString("en-US");
}
