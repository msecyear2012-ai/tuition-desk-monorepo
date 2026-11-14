export type MainFeeTab = "overview" | "payments" | "handovers";
export type PaymentsSubTab = "pending" | "review" | "paid";

export interface ResolvedFeeTabs {
  initialTab: MainFeeTab;
  initialSub: PaymentsSubTab;
}

/**
 * Resolves 3-section Fee Management tab and sub-tab from URL search parameters.
 * Guarantees identical resolution between server SSR and client navigation.
 */
export function resolveFeeTabs(params: {
  tab?: string | string[] | null;
  sub?: string | string[] | null;
}): ResolvedFeeTabs {
  const tabParam = typeof params.tab === "string" ? params.tab : undefined;
  const subParam = typeof params.sub === "string" ? params.sub : undefined;

  let initialTab: MainFeeTab = "overview";
  if (tabParam === "handovers") {
    initialTab = "handovers";
  } else if (
    tabParam === "payments" ||
    tabParam === "pending" ||
    tabParam === "review" ||
    tabParam === "paid"
  ) {
    initialTab = "payments";
  }

  let initialSub: PaymentsSubTab = "pending";
  if (subParam === "review" || tabParam === "review") {
    initialSub = "review";
  } else if (subParam === "paid" || tabParam === "paid") {
    initialSub = "paid";
  }

  return { initialTab, initialSub };
}
