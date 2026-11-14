export interface PaymentReceiverItem {
  receiverId: string | null;
  receiverRole: "owner" | "teacher";
  name: string;
  phone: string;
  totalAmount: number;
  transactionCount: number;
}

export interface AcademicTeacherItem {
  teacherId: string | null;
  isOwner: boolean;
  name: string;
  phone: string;
  totalAmount: number;
  transactionCount: number;
}

export interface AttributionMetric {
  totalAmount: number;
  transactionCount: number;
  sharePct: number;
}

export interface CombinedAttributionPerson {
  key: string;
  name: string;
  phone: string;
  role: "owner" | "teacher";
  hasBothRoles: boolean;
  custody: AttributionMetric | null;
  academic: AttributionMetric | null;
}

/**
 * Derives a stable database-driven identity key for a payment receiver.
 * Uses receiverId / role, never name or phone.
 */
export function getPersonKeyForReceiver(item: PaymentReceiverItem): string {
  if (item.receiverRole === "owner" || !item.receiverId) {
    return "owner";
  }
  return `teacher:${item.receiverId}`;
}

/**
 * Derives a stable database-driven identity key for an academic teacher.
 * Uses teacherId / isOwner, never name or phone.
 */
export function getPersonKeyForAcademic(item: AcademicTeacherItem): string {
  if (item.isOwner || !item.teacherId) {
    return "owner";
  }
  return `teacher:${item.teacherId}`;
}

/**
 * Cleans user display name by stripping trailing ' (Owner)' artifact if present,
 * since the UI renders dedicated role badges.
 */
export function cleanDisplayName(name: string): string {
  if (!name) return "";
  return name.replace(/\s*\(Owner\)$/i, "").trim();
}

/**
 * Consolidates the dual attribution arrays (Cash Custody vs Academic Responsibility)
 * into a single unified person-based list without mutating or duplicating financial totals.
 *
 * Matching is performed strictly by stable database identity (receiverId / teacherId / 'owner'),
 * NEVER by names or phone numbers.
 *
 * When a person exists in only one dimension, only that metric is populated.
 * No zero-value transactions are invented.
 */
export function combineAttributionData(
  receivers: PaymentReceiverItem[] = [],
  academics: AcademicTeacherItem[] = [],
  totalRevenue: number = 0
): CombinedAttributionPerson[] {
  const map = new Map<
    string,
    {
      key: string;
      name: string;
      phone: string;
      role: "owner" | "teacher";
      receiverItem: PaymentReceiverItem | null;
      academicItem: AcademicTeacherItem | null;
    }
  >();

  // 1. Process Payment Receivers (Cash Custody)
  for (const r of receivers) {
    const key = getPersonKeyForReceiver(r);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        name: cleanDisplayName(r.name) || r.name,
        phone: r.phone || "",
        role: r.receiverRole === "owner" ? "owner" : "teacher",
        receiverItem: { ...r },
        academicItem: null,
      });
    } else {
      if (existing.receiverItem) {
        existing.receiverItem.totalAmount += r.totalAmount;
        existing.receiverItem.transactionCount += r.transactionCount;
      } else {
        existing.receiverItem = { ...r };
      }
      if (r.receiverRole === "owner") {
        existing.role = "owner";
      }
      if (!existing.phone && r.phone) {
        existing.phone = r.phone;
      }
    }
  }

  // 2. Process Academic Teachers (Academic Attribution)
  for (const a of academics) {
    const key = getPersonKeyForAcademic(a);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        name: cleanDisplayName(a.name) || a.name,
        phone: a.phone || "",
        role: a.isOwner ? "owner" : "teacher",
        receiverItem: null,
        academicItem: { ...a },
      });
    } else {
      if (existing.academicItem) {
        existing.academicItem.totalAmount += a.totalAmount;
        existing.academicItem.transactionCount += a.transactionCount;
      } else {
        existing.academicItem = { ...a };
      }
      if (a.isOwner) {
        existing.role = "owner";
      }
      if (!existing.phone && a.phone) {
        existing.phone = a.phone;
      }
    }
  }

  // 3. Build combined person records with calculated percentage shares
  const result: CombinedAttributionPerson[] = [];

  for (const entry of map.values()) {
    const custodyMetric: AttributionMetric | null = entry.receiverItem
      ? {
          totalAmount: entry.receiverItem.totalAmount,
          transactionCount: entry.receiverItem.transactionCount,
          sharePct:
            totalRevenue > 0
              ? Math.round((entry.receiverItem.totalAmount / totalRevenue) * 100)
              : 0,
        }
      : null;

    const academicMetric: AttributionMetric | null = entry.academicItem
      ? {
          totalAmount: entry.academicItem.totalAmount,
          transactionCount: entry.academicItem.transactionCount,
          sharePct:
            totalRevenue > 0
              ? Math.round((entry.academicItem.totalAmount / totalRevenue) * 100)
              : 0,
        }
      : null;

    const hasBothRoles = Boolean(custodyMetric && academicMetric);

    result.push({
      key: entry.key,
      name: entry.name,
      phone: entry.phone,
      role: entry.role,
      hasBothRoles,
      custody: custodyMetric,
      academic: academicMetric,
    });
  }

  // 4. Sort deterministically: highest single-dimension total amount first, owners prioritized, then alphabetical
  result.sort((a, b) => {
    const maxA = Math.max(a.custody?.totalAmount ?? 0, a.academic?.totalAmount ?? 0);
    const maxB = Math.max(b.custody?.totalAmount ?? 0, b.academic?.totalAmount ?? 0);
    if (maxB !== maxA) return maxB - maxA;
    if (a.role === "owner" && b.role !== "owner") return -1;
    if (b.role === "owner" && a.role !== "owner") return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}
