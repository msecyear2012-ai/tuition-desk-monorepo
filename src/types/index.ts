export interface NavItem {
  id: string;
  label: string;
  href: string;
  badge?: number | string;
  icon: string;
}

export interface TuitionCenterConfig {
  id: string;
  name: string;
  tagline: string;
  logoUrl?: string;
  primaryColor: string;
  ownerName: string;
  city: string;
}

export interface DashboardMetrics {
  collectedFeesThisMonth: number;
  pendingFeesTotal: number;
  totalActiveStudents: number;
  totalBatchesToday: number;
  pendingTestsCount: number;
  newEnquiriesCount: number;
  attendanceTodayPercentage: number;
  overdueCount?: number;
  todayAttendance?: number;
}

export interface QuickBatchAttendance {
  id: string;
  batchName: string;
  subject: string;
  timeSlot: string;
  room?: string;
  totalStudents: number;
  markedStudents: number;
  status: "pending" | "completed";
  timelineStatus: "ongoing" | "upcoming" | "completed";
}

export interface RecentActivityItem {
  id: string;
  title: string;
  subtitle: string;
  time: string;
  type: "fee" | "attendance" | "test" | "enquiry";
  amount?: number;
}

export type AttendanceStatus = "present" | "absent" | "unmarked";

export interface StudentAttendanceItem {
  id: string;
  name: string;
  rollNumber: string;
  avatarColor: string;
  initials: string;
  parentPhone: string;
  attendanceRate: number;
  assignedTeacherName?: string;
}

export interface OverdueFeeStudent {
  id: string; // Identifier for UI keys/backwards compatibility (contains feeId)
  feeId?: string; // Explicit MongoDB Fee record _id
  studentId?: string; // Explicit MongoDB Student record _id
  name: string;
  batchName: string;
  pendingAmount: number;
  totalAmount?: number;
  paidAmount?: number;
  daysLate: number;
  parentName: string;
  parentPhone: string;
  dueDate: string;
  lastReminderSent?: string;
  avatarColor: string;
  initials: string;
  status?: "Pending" | "Paid" | "Verification Pending" | "Partial Paid";
  title?: string;
  month?: string;
  paidDate?: string;
  paidAt?: string;
  paymentDate?: string;
  utrNumber?: string;
  paymentMode?: string;
  receiptNumber?: string;
  receivedByName?: string;
  receivedByRole?: "owner" | "teacher";
  assignedTeacherName?: string;
  batchAtPayment?: string;
  originalAmountDue?: number;
  paymentHistory?: PaymentEntryItem[];
  custodyBreakdown?: CustodyBreakdownItem;
  hasPaymentProof?: boolean;
  latestPaymentProofId?: string;
  rejectionReason?: string;
}

export interface PaymentAllocationItem {
  _id?: string;
  allocationId?: string;
  handoverId: string;
  handoverNumber?: string;
  allocatedAmount: number;
  allocatedAt?: string | Date;
  status: "pending_verification" | "verified" | "rejected" | "disputed" | "shortage_confirmed";
  verifiedAmount?: number;
  verifiedAt?: string | Date | null;
  rejectionReason?: string;
  notes?: string;
}

export interface PaymentEntryItem {
  _id?: string;
  paymentId?: string;
  amount: number;
  paymentDate: string | Date;
  paymentMode: string;
  receiptNumber: string;
  finalReceiptNumber?: string;
  isProvisional?: boolean;
  receivedBy?: string;
  receivedByName?: string;
  receivedByRole?: "owner" | "teacher" | string;
  recordedBy?: string;
  recordedByName?: string;
  recordedByRole?: string;
  recordedAt?: string | Date;
  assignedTeacherName?: string;
  batchAtPayment?: string;
  custodyStatus?:
    | "teacher_custody"
    | "teacher_in_hand"
    | "owner_pending"
    | "owner_verified"
    | "owner_custody"
    | "shortage_deficit"
    | "split_custody"
    | string;
  allocations?: PaymentAllocationItem[];
  notes?: string;
}

export interface CustodyBreakdownItem {
  totalAmount: number;
  teacherInHandAmount: number;
  ownerPendingVerificationAmount: number;
  ownerVerifiedAmount: number;
  disputedDiscrepancyAmount: number;
  custodyLabel:
    | "owner_verified"
    | "owner_pending"
    | "teacher_in_hand"
    | "shortage_deficit"
    | "split_custody";
}

export type HandoverStatus =
  | "pending_approval"
  | "approved"
  | "partially_approved"
  | "rejected";

export type HandoverDiscrepancyStatus =
  | "none"
  | "disputed"
  | "resolved"
  | "shortage_confirmed";

export type DisputeResolutionType =
  | "cash_received"
  | "accounting_adjustment"
  | "shortage_confirmed";

export interface HandoverItemAllocation {
  allocationId?: string;
  paymentId: string;
  feeId: string;
  studentId: string;
  studentName?: string;
  amount: number;
  receiptNumber?: string;
}

export interface HandoverDisputeEntry {
  _id?: string;
  initiatedBy: string;
  initiatedByRole: "owner" | "teacher";
  notes: string;
  evidenceUrl?: string;
  timestamp: string | Date;
}

export interface HandoverResolutionEntry {
  _id?: string;
  resolutionType: DisputeResolutionType;
  amount: number;
  resolvedBy: string;
  resolvedAt: string | Date;
  reason: string;
  auditReference: string;
  notes?: string;
}

export interface HandoverIncrementalSettlement {
  _id?: string;
  amountReceived: number;
  receivedAt: string | Date;
  receivedBy: string;
  remainingDiscrepancy: number;
  notes?: string;
}

export interface CashHandoverRecord {
  _id: string;
  centerId: string;
  handoverNumber: string;
  teacherId: string;
  teacherName?: string;
  submittedAmount: number;
  approvedAmount?: number;
  discrepancyAmount?: number;
  status: HandoverStatus;
  discrepancyStatus?: HandoverDiscrepancyStatus;
  items: HandoverItemAllocation[];
  submittedAt: string | Date;
  submissionNotes?: string;
  approvedBy?: string;
  approvedAt?: string | Date;
  rejectionReason?: string;
  rejectedAt?: string | Date;
  disputes?: HandoverDisputeEntry[];
  resolutions?: HandoverResolutionEntry[];
  incrementalSettlements?: HandoverIncrementalSettlement[];
}

export interface EligibleCollectionItem {
  feeId: string;
  paymentId: string;
  studentId: string;
  studentName: string;
  studentBatch?: string;
  receiptNumber: string;
  paymentDate: string | Date;
  totalCollected: number;
  alreadyAllocated: number;
  availableAmount: number;
  feeMonth?: string;
  feeTitle?: string;
}

export interface TestScoreItem {
  id: string;
  testCode: string;
  testName: string;
  subject: string;
  date: string;
  score: number;
  totalMarks: number;
  classAverage: number;
  highestScore: number;
}

export interface StudentTestProfile {
  id: string;
  name: string;
  batchName: string;
  rollNumber: string;
  avatarColor: string;
  initials: string;
  parentPhone: string;
  latestScore: number;
  latestTotal: number;
  trendPercentage: number;
  currentRank: number;
  totalBatchStudents: number;
  tests: TestScoreItem[];
}

export interface HomeworkItem {
  id: string;
  subject: string;
  title: string;
  description: string;
  dueDate: string;
  status: "pending" | "submitted" | "note";
  teacherName: string;
}

export interface ParentDashboardData {
  childName: string;
  batchName: string;
  rollNumber: string;
  initials: string;
  avatarColor: string;
  attendancePercentage: number;
  totalClassesHeld: number;
  classesAttended: number;
  classesMissed: number;
  feeStatus: "due" | "paid";
  pendingFeeAmount: number;
  feeDueDate: string;
  feeDaysLate: number;
  upiId: string;
  homework: HomeworkItem[];
}

export interface StudentRecord {
  _id: string;
  centerId: string;
  name: string;
  batch: string;
  parentWhatsApp: string;
  isActive: boolean;
  joiningDate?: string;
  monthlyFee: number;
  billingCycleDate: number;
  assignedTeacherId?: string | null;
  advanceBalance?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface TeacherRecord {
  _id: string;
  centerId: string;
  name: string;
  loginId: string;
  phone: string;
  email?: string;
  role: "teacher";
  subjects?: string[];
  assignedBatches?: string[];
  isActive: boolean;
  mustChangePassword?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface BatchRecord {
  _id: string;
  centerId: string;
  name: string;
  timing?: string;
  subject?: string;
  assignedTeacherId?: string | null;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface TestResult {
  studentId: string;
  marksObtained: number;
  isAbsent?: boolean;
}

export interface TestRecord {
  _id: string;
  centerId: string;
  assignedTeacherId?: string | null;
  title: string;
  batch: string;
  date: string;
  maxMarks: number;
  results?: TestResult[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StudentBatchRequestRecord {
  _id: string;
  centerId: string;
  studentId: string | StudentRecord;
  batchName: string;
  batchId?: string;
  requesterId: string;
  requesterRole: "teacher" | "owner";
  requesterName: string;
  status: "pending" | "approved" | "rejected";
  currentBatch?: string;
  requestNotes?: string;
  reviewedBy?: string;
  reviewedByName?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}



export interface FinancialSummaryKPIs {
  totalParentCollections: number;
  verifiedCashReceived: number;
  teacherHeldCash: number;
  pendingVerificationCash: number;
  outstandingFeeBalance: number;
  activeDiscrepancies: number;
}

export interface TeacherReportRow {
  teacherId: string;
  teacherName: string;
  totalCollected: number;
  teacherInHandAmount: number;
  ownerPendingAmount: number;
  ownerVerifiedAmount: number;
  activeDiscrepancies: number;
  transactionCount: number;
  teacherLoginId?: string;
  cashInHand?: number;
  cashSubmitted?: number;
  cashVerified?: number;
}

export interface BatchReportRow {
  batchName: string;
  studentCount: number;
  totalInvoiced: number;
  totalCollected: number;
  outstandingBalance: number;
  partialPaymentCount: number;
  collectionRate: number;
  collectionRatePercent?: number;
}

export interface StudentLedgerPaymentItem {
  paymentId: string;
  amount: number;
  paymentMode: string;
  paymentDate: string;
  receiptNumber: string;
  receivedByName: string;
  receivedByRole: "owner" | "teacher";
  custodyLabel: string;
  custodyStatus?: string;
  isOwnerVerified: boolean;
  status: string;
}

export interface StudentLedgerRow {
  feeId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  parentPhone: string;
  batchName: string;
  batch?: string;
  amountDue: number;
  paidAmount: number;
  outstandingBalance: number;
  originalAmountDue?: number;
  feeStatus: string;
  status?: string;
  month?: string;
  feeMonth?: string;
  payments: StudentLedgerPaymentItem[];
}

export interface HandoverReportRow {
  handoverId: string;
  handoverNumber: string;
  teacherId: string;
  teacherName: string;
  submittedAt: string;
  submittedAmount: number;
  approvedAmount: number;
  discrepancyAmount: number;
  remainingDiscrepancy: number;
  status: string;
  discrepancyStatus: string;
  itemCount: number;
  resolutionsCount: number;
  settlementsCount: number;
}

export interface FinancialSummaryResponse {
  success: boolean;
  kpis: FinancialSummaryKPIs;
  filters: {
    startDate?: string;
    endDate?: string;
    teacherId?: string;
    batch?: string;
    student?: string;
    status?: string;
    handoverStatus?: string;
  };
  teacherReports: TeacherReportRow[];
  batchReports: BatchReportRow[];
  studentLedger: StudentLedgerRow[];
  handoverReports: HandoverReportRow[];
  error?: string;
}
