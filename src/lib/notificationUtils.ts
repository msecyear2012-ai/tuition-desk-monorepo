/**
 * Notification category and filter utilities for the frontend.
 */

export function resolveNotificationCategory(category?: string, type?: string): string {
  if (category && category !== "general") return category.toLowerCase();
  if (type === "cash_collection" || type === "fee_reminder") return "fee";
  if (
    type === "handover_submitted" ||
    type === "handover_verified" ||
    type === "handover_rejected" ||
    type === "dispute_raised" ||
    type === "dispute_resolved"
  )
    return "handover";
  if (
    type === "batch_request_submitted" ||
    type === "batch_request_approved" ||
    type === "batch_request_rejected"
  )
    return "batch";
  if (
    type === "student_admitted" ||
    type === "attendance_marked" ||
    type === "test_scheduled" ||
    type === "test_result" ||
    type === "homework_assigned" ||
    type === "marks_entered"
  )
    return "academic";
  if (type === "parent_message" || type === "whatsapp_simulation" || type === "message_dispatched")
    return "communication";
  return "system";
}
