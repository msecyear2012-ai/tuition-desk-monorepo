"use client";

import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  QrCode,
  CheckCircle2,
  ShieldCheck,
  X,
  Smartphone,
  ExternalLink,
  Clock,
  Loader2,
  Copy,
  Check,
  Sparkles,
  CreditCard,
  IndianRupee,
  Camera,
  UploadCloud,
  FileImage,
  Trash2,
  AlertCircle,
  FileText,
  Hash,
} from "lucide-react";

interface FeeActionCardProps {
  feeId?: string | null;
  studentId?: string;
  centerId?: string;
  amount: number;
  dueDate: string;
  daysLate: number;
  upiId: string;
  centerName?: string;
  status?: "Pending" | "Paid" | "Verification Pending" | "Partial Paid";
  utrNumber?: string;
  rejectionReason?: string | null;
  onPaymentSuccess?: () => void;
  onUtrSubmitted?: (utr: string) => void;
  onAdvancePaymentSuccess?: () => void;
  onProofSubmitted?: (proofData: any) => void;
  isPaid?: boolean;
  advanceBalance?: number;
}

const QUICK_ADVANCE_AMOUNTS = [1000, 2000, 3000, 5000];

export default function FeeActionCard({
  feeId,
  studentId,
  centerId,
  amount,
  dueDate,
  daysLate,
  upiId = "9876543210@paytm",
  centerName = "Tuition Center",
  status = "Pending",
  utrNumber: initialUtr = "",
  rejectionReason = null,
  onPaymentSuccess,
  onUtrSubmitted,
  onAdvancePaymentSuccess,
  onProofSubmitted,
  isPaid = false,
  advanceBalance = 0,
}: FeeActionCardProps) {
  // Regular Payment Modal States
  const [showUpiModal, setShowUpiModal] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<
    "Pending" | "Paid" | "Verification Pending" | "Partial Paid"
  >(isPaid ? "Paid" : status);
  const [utrInput, setUtrInput] = useState("");
  const [savedUtr, setSavedUtr] = useState(initialUtr);
  const [submittingUtr, setSubmittingUtr] = useState(false);
  const [utrError, setUtrError] = useState<string | null>(null);
  const [copiedVpa, setCopiedVpa] = useState(false);

  // Real-Time Polling & Buried Fallback States (Regular Payment)
  const [regularPaymentSuccess, setRegularPaymentSuccess] = useState(false);
  const [regularDelayedButtonVisible, setRegularDelayedButtonVisible] = useState(false);
  const [showManualUtrInput, setShowManualUtrInput] = useState(false);

  // Pre-flight Payment Gateway Health Check (Cold-Start Fix for Render deployment)
  const [gatewayPinging, setGatewayPinging] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  const pingServer = async (): Promise<boolean> => {
    const rawGatewayUrl =
      process.env.NEXT_PUBLIC_PAYMENT_GATEWAY_URL ||
      process.env.NEXT_PUBLIC_YOUPI_URL ||
      (typeof window !== "undefined" && window.location.hostname === "localhost"
        ? "http://localhost:6100"
        : "");

    const targetUrl = rawGatewayUrl
      ? `${rawGatewayUrl.replace(/\/+$/, "")}/health`
      : "/api/health";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(targetUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeoutId);
      return res.status === 200;
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  };

  const handlePayFees = async () => {
    if (gatewayPinging) return;
    setGatewayError(null);
    setGatewayPinging(true);

    try {
      await pingServer().catch(() => false);
      setRegularPaymentSuccess(false);
      setShowUpiModal(true);
    } catch {
      setRegularPaymentSuccess(false);
      setShowUpiModal(true);
    } finally {
      setGatewayPinging(false);
    }
  };

  // Advance Payment Modal States
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [advanceAmountInput, setAdvanceAmountInput] = useState<string>("3000");
  const [createdAdvanceFee, setCreatedAdvanceFee] = useState<{
    _id: string;
    amountDue: number;
  } | null>(null);
  const [advanceCreating, setAdvanceCreating] = useState(false);
  const [advancePaymentSuccess, setAdvancePaymentSuccess] = useState(false);
  const [advanceDelayedButtonVisible, setAdvanceDelayedButtonVisible] = useState(false);
  const [showAdvanceManualUtrInput, setShowAdvanceManualUtrInput] = useState(false);
  const [advanceUtrInput, setAdvanceUtrInput] = useState("");
  const [submittingAdvanceUtr, setSubmittingAdvanceUtr] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  // In-modal advance proof upload states
  const [showAdvanceProofForm, setShowAdvanceProofForm] = useState(false);
  const [advanceProofFile, setAdvanceProofFile] = useState<File | null>(null);
  const [advanceProofNotes, setAdvanceProofNotes] = useState("");
  const [isSubmittingAdvanceProof, setIsSubmittingAdvanceProof] = useState(false);

  // Payment Proof Screenshot Modal & Upload States
  const [showProofModal, setShowProofModal] = useState(false);
  const [selectedProofFile, setSelectedProofFile] = useState<File | null>(null);
  const [proofPreviewUrl, setProofPreviewUrl] = useState<string | null>(null);
  const [proofUtrInput, setProofUtrInput] = useState("");
  const [proofNotesInput, setProofNotesInput] = useState("");
  const [isUploadingProof, setIsUploadingProof] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [proofSuccess, setProofSuccess] = useState(false);

  // Mobile UPI Intent Capture States & Truthful UTR Fetch Lifecycle
  const [launchedUpi, setLaunchedUpi] = useState(false);
  const [detectedUtrFromApp, setDetectedUtrFromApp] = useState<string | null>(null);
  const [utrFetchStatus, setUtrFetchStatus] = useState<"idle" | "fetched" | "not_fetched">("idle");
  const [upiAppError, setUpiAppError] = useState<string | null>(null);
  const [showInModalSubmission, setShowInModalSubmission] = useState(false);

  // Helper: Validates genuine UTR extracted from UPI application without guessing or placeholders
  const validateExtractedUtr = (raw: string | null | undefined): string | null => {
    if (!raw || typeof raw !== "string") return null;
    const trimmed = raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (trimmed.length < 6 || trimmed.length > 30) return null;
    if (trimmed.startsWith("FEE-") || trimmed.startsWith("FEE_")) return null;
    const forbidden = [
      "SUCCESS", "FAILURE", "SUBMITTED", "PENDING", "CANCELLED",
      "TRUE", "FALSE", "UNDEFINED", "NULL", "NONE", "OK",
      "NOT_FETCHED", "NOTFETCHED", "UTR_NOT_FETCHED", "UTRNOTFETCHED"
    ];
    if (forbidden.includes(trimmed)) return null;
    return trimmed;
  };

  // Clean up object URL when proofPreviewUrl changes or unmounts
  useEffect(() => {
    return () => {
      if (proofPreviewUrl) {
        URL.revokeObjectURL(proofPreviewUrl);
      }
    };
  }, [proofPreviewUrl]);

  // Inspect standard NPCI UPI Intent response parameters on return
  useEffect(() => {
    if (typeof window === "undefined") return;

    const inspectUpiResponse = () => {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

        // Standard NPCI response parameters
        const txnId = searchParams.get("txnId") || hashParams.get("txnId") || "";
        const approvalRef =
          searchParams.get("ApprovalRefNo") ||
          searchParams.get("approvalRefNo") ||
          searchParams.get("refId") ||
          searchParams.get("rrn") ||
          hashParams.get("ApprovalRefNo") ||
          hashParams.get("approvalRefNo") ||
          hashParams.get("refId") ||
          hashParams.get("rrn") ||
          "";
        const status = (searchParams.get("Status") || hashParams.get("Status") || "").toUpperCase();
        const responseCode = searchParams.get("responseCode") || hashParams.get("responseCode") || "";

        if (status === "FAILURE" || responseCode === "ZM" || responseCode === "U16") {
          setUpiAppError("UPI transaction was cancelled or unsuccessful in app. If amount was deducted, please upload your screenshot or enter your UTR number below.");
        }

        const validUtr = validateExtractedUtr(approvalRef) || validateExtractedUtr(txnId);
        if (validUtr) {
          setDetectedUtrFromApp(validUtr);
          setUtrFetchStatus("fetched");
          setProofUtrInput(validUtr);
          setShowInModalSubmission(true);
        } else if (launchedUpi) {
          setDetectedUtrFromApp(null);
          setUtrFetchStatus("not_fetched");
          setProofUtrInput("");
          setShowInModalSubmission(true);
        }
      } catch (e) {
        console.warn("[FeeActionCard] Error inspecting UPI response:", e);
      }
    };

    inspectUpiResponse();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        inspectUpiResponse();
      }
    };

    window.addEventListener("focus", inspectUpiResponse);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", inspectUpiResponse);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [launchedUpi]);

  // Target UPI ID
  const targetUpiId = upiId || "9876543210@paytm";

  // Helper for Parent Portal Auth Headers
  const getParentPortalAuthHeaders = (): Record<string, string> => {
    if (typeof window === "undefined") return { Accept: "application/json" };
    const token =
      sessionStorage.getItem("parent_portal_session_token") ||
      localStorage.getItem("parent_portal_session_token") ||
      localStorage.getItem("auth_token");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  };

  // Construct regular payment UPI Intent Deep-Link with Transaction Note
  const customRef = `FEE-${(feeId || "").toString().slice(-6)}`;
  const upiLink = `upi://pay?pa=${encodeURIComponent(
    targetUpiId
  )}&pn=${encodeURIComponent(centerName)}&am=${amount}&tn=${encodeURIComponent(
    customRef
  )}&cu=INR`;

  // Numeric advance amount
  const numericAdvance = Math.max(0, Number(advanceAmountInput) || 0);

  // Construct advance payment UPI Intent link using createdAdvanceFee ID if available
  const advanceFeeId = createdAdvanceFee?._id || "";
  const advanceCustomRef = advanceFeeId
    ? `FEE-${advanceFeeId.toString().slice(-6)}`
    : `FEE-ADV-${(studentId || "").toString().slice(-6)}`;
  const advanceUpiLink = `upi://pay?pa=${encodeURIComponent(
    targetUpiId
  )}&pn=${encodeURIComponent(centerName)}&am=${
    createdAdvanceFee ? createdAdvanceFee.amountDue : numericAdvance
  }&tn=${encodeURIComponent(advanceCustomRef)}&cu=INR`;

  // =========================================================================
  // TASK 2: EXPLICIT CLICK HANDLERS (Eliminates Desktop upi:// Console Errors)
  // =========================================================================
  const handleOpenUpiApp = (e: React.MouseEvent) => {
    e.preventDefault();
    setLaunchedUpi(true);
    if (typeof window !== "undefined") {
      window.location.href = upiLink;
    }
  };

  const handleOpenAdvanceUpiApp = (e: React.MouseEvent) => {
    e.preventDefault();
    if (typeof window !== "undefined") {
      window.location.href = advanceUpiLink;
    }
  };

  // =========================================================================
  // TASK 1, 3 & 4: REGULAR PAYMENT REAL-TIME POLLING, FALLBACK, AND SUCCESS
  // =========================================================================

  // 1. 30-Second timer to reveal "Payment taking too long? Enter UTR manually"
  useEffect(() => {
    if (!showUpiModal) {
      setRegularDelayedButtonVisible(false);
      setShowManualUtrInput(false);
      setRegularPaymentSuccess(false);
      return;
    }

    const timer = setTimeout(() => {
      setRegularDelayedButtonVisible(true);
    }, 30000); // exactly 30 seconds

    return () => clearTimeout(timer);
  }, [showUpiModal]);

  // 2. Real-time polling every 3 seconds for regular fee status
  useEffect(() => {
    if (!showUpiModal || !feeId || regularPaymentSuccess) return;

    const backendUrl =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

    let isSubscribed = true;
    let pollCount = 0;
    let consecutiveErrors = 0;
    const MAX_POLL_COUNT = 100; // 5 minutes max at 3s intervals (avoids hanging indefinitely)
    const controller = new AbortController();

    const pollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > MAX_POLL_COUNT) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const res = await fetch(`${backendUrl}/fees/${feeId}`, {
          method: "GET",
          credentials: "include",
          headers: getParentPortalAuthHeaders(),
          signal: controller.signal,
        });

        if (!isSubscribed) return;

        // Terminal HTTP error states: 401 (unauthenticated), 403 (unauthorized/cross-tenant), 404 (not found)
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          clearInterval(pollInterval);
          return;
        }

        if (res.ok) {
          consecutiveErrors = 0;
          const json = await res.json();
          const feeStatus = json?.data?.status;

          if (feeStatus === "Paid") {
            clearInterval(pollInterval);
            setRegularPaymentSuccess(true);
            setTimeout(() => {
              if (!isSubscribed) return;
              setShowUpiModal(false);
              setCurrentStatus("Paid");
              if (onPaymentSuccess) onPaymentSuccess();
            }, 3000); // exactly 3 seconds
          } else if (feeStatus === "Cancelled") {
            clearInterval(pollInterval);
          } else if (feeStatus === "Verification Pending") {
            setCurrentStatus("Verification Pending");
            if (json?.data?.utrNumber) {
              setSavedUtr(json.data.utrNumber);
            }
          }
        } else {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            clearInterval(pollInterval);
          }
        }
      } catch (err: unknown) {
        if (!isSubscribed) return;
        if (err instanceof Error && err.name === "AbortError") return;
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          clearInterval(pollInterval);
        }
      }
    }, 3000); // 3 seconds interval

    return () => {
      isSubscribed = false;
      clearInterval(pollInterval);
      controller.abort();
    };
  }, [showUpiModal, feeId, regularPaymentSuccess, onPaymentSuccess]);

  // =========================================================================
  // TASK 1, 3 & 4: ADVANCE PAYMENT REAL-TIME POLLING, FALLBACK, AND SUCCESS
  // =========================================================================

  // 1. 30-Second timer for advance payment fallback
  useEffect(() => {
    if (!createdAdvanceFee?._id || advancePaymentSuccess) {
      setAdvanceDelayedButtonVisible(false);
      setShowAdvanceManualUtrInput(false);
      return;
    }

    const timer = setTimeout(() => {
      setAdvanceDelayedButtonVisible(true);
    }, 30000); // exactly 30 seconds

    return () => clearTimeout(timer);
  }, [createdAdvanceFee?._id, advancePaymentSuccess]);

  // 2. Real-time polling every 3 seconds for advance fee status
  useEffect(() => {
    if (!createdAdvanceFee?._id || advancePaymentSuccess) return;

    const backendUrl =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

    let isSubscribed = true;
    let pollCount = 0;
    let consecutiveErrors = 0;
    const MAX_POLL_COUNT = 100; // 5 minutes max at 3s intervals
    const controller = new AbortController();

    const pollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > MAX_POLL_COUNT) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const res = await fetch(`${backendUrl}/fees/${createdAdvanceFee._id}`, {
          method: "GET",
          credentials: "include",
          headers: getParentPortalAuthHeaders(),
          signal: controller.signal,
        });

        if (!isSubscribed) return;

        // Terminal HTTP error states: 401, 403, 404
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          clearInterval(pollInterval);
          return;
        }

        if (res.ok) {
          consecutiveErrors = 0;
          const json = await res.json();
          const feeStatus = json?.data?.status;

          if (feeStatus === "Paid") {
            clearInterval(pollInterval);
            setAdvancePaymentSuccess(true);
            setTimeout(() => {
              if (!isSubscribed) return;
              setShowAdvanceModal(false);
              setCreatedAdvanceFee(null);
              setAdvancePaymentSuccess(false);
              if (onAdvancePaymentSuccess) {
                onAdvancePaymentSuccess();
              } else if (onPaymentSuccess) {
                onPaymentSuccess();
              }
            }, 3000); // exactly 3 seconds
          } else if (feeStatus === "Cancelled") {
            clearInterval(pollInterval);
          }
        } else {
          consecutiveErrors++;
          if (consecutiveErrors >= 5) {
            clearInterval(pollInterval);
          }
        }
      } catch (err: unknown) {
        if (!isSubscribed) return;
        if (err instanceof Error && err.name === "AbortError") return;
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          clearInterval(pollInterval);
        }
      }
    }, 3000); // 3 seconds interval

    return () => {
      isSubscribed = false;
      clearInterval(pollInterval);
      controller.abort();
    };
  }, [
    createdAdvanceFee?._id,
    advancePaymentSuccess,
    onAdvancePaymentSuccess,
    onPaymentSuccess,
  ]);

  // Initiate advance payment (creates Fee record in advance so it can be polled)
  const handleInitiateAdvancePayment = async () => {
    if (numericAdvance <= 0) {
      setAdvanceError("Advance payment amount must be greater than 0.");
      return;
    }

    setAdvanceCreating(true);
    setAdvanceError(null);

    try {
      const backendUrl =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

      const token =
        typeof window !== "undefined"
          ? sessionStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("parent_portal_session_token") ||
            undefined
          : undefined;

      const res = await fetch(`${backendUrl}/fees/advance`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...getParentPortalAuthHeaders(),
        },
        body: JSON.stringify({
          studentId,
          centerId,
          amount: numericAdvance,
          token,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success || !data?.data?._id) {
        throw new Error(data?.error || "Failed to initiate advance payment.");
      }

      setCreatedAdvanceFee(data.data);
    } catch (err: unknown) {
      setAdvanceError(
        err instanceof Error ? err.message : "Failed to initiate advance payment."
      );
    } finally {
      setAdvanceCreating(false);
    }
  };

  // Handle regular UTR submission fallback
  const handleSubmitUtr = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUtr = utrInput.trim();

    if (!cleanUtr || cleanUtr.length < 6) {
      setUtrError("Please enter a valid 12-digit UTR / Transaction reference.");
      return;
    }

    if (!feeId) {
      setCurrentStatus("Verification Pending");
      setSavedUtr(cleanUtr);
      setShowUpiModal(false);
      if (onUtrSubmitted) onUtrSubmitted(cleanUtr);
      return;
    }

    setSubmittingUtr(true);
    setUtrError(null);

    try {
      const backendUrl =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

      const token =
        typeof window !== "undefined"
          ? sessionStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("auth_token")
          : null;

      const authHeaders: Record<string, string> = {};
      if (token) {
        authHeaders["Authorization"] = `Bearer ${token}`;
      }

      const res = await fetch(`${backendUrl}/fees/${feeId}/submit-utr`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({ utrNumber: cleanUtr }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Failed to submit UTR reference.");
      }

      setCurrentStatus("Verification Pending");
      setSavedUtr(cleanUtr);
      setShowUpiModal(false);
      if (onUtrSubmitted) onUtrSubmitted(cleanUtr);
      if (onPaymentSuccess) onPaymentSuccess();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to submit UTR details.";
      setUtrError(msg);
    } finally {
      setSubmittingUtr(false);
    }
  };

  // Handle selecting advance screenshot file
  const handleSelectAdvanceProofFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setAdvanceError("Only JPG, PNG, and WebP images are supported.");
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      setAdvanceError("Screenshot file size must be less than 3 MB.");
      return;
    }

    setAdvanceProofFile(file);
    setAdvanceError(null);
  };

  const handleClearAdvanceProofFile = () => {
    setAdvanceProofFile(null);
  };

  // Handle advance UTR / Screenshot submission
  const handleSubmitAdvanceProof = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createdAdvanceFee?._id) return;

    const cleanUtr = advanceUtrInput.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");

    if (!cleanUtr && !advanceProofFile) {
      setAdvanceError("Please enter a transaction UTR or attach a payment screenshot.");
      return;
    }

    if (cleanUtr && (cleanUtr.length < 6 || cleanUtr.length > 30)) {
      setAdvanceError("Please enter a valid UTR (6-30 alphanumeric characters).");
      return;
    }

    setIsSubmittingAdvanceProof(true);
    setAdvanceError(null);

    try {
      const backendUrl =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

      const token =
        typeof window !== "undefined"
          ? sessionStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("auth_token")
          : null;

      const authHeaders: Record<string, string> = {};
      if (token) {
        authHeaders["Authorization"] = `Bearer ${token}`;
      }

      if (advanceProofFile) {
        const formData = new FormData();
        formData.append("file", advanceProofFile);
        if (cleanUtr) {
          formData.append("utrNumber", cleanUtr);
        }
        if (advanceProofNotes.trim()) {
          formData.append("notes", advanceProofNotes.trim());
        }
        if (token) {
          formData.append("token", token);
        }
        formData.append("amount", String(createdAdvanceFee.amountDue));

        const res = await fetch(
          `${backendUrl}/fees/${createdAdvanceFee._id}/payment-proof`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json",
              ...authHeaders,
            },
            body: formData,
          }
        );

        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || "Failed to upload advance payment proof.");
        }

        if (onProofSubmitted) {
          onProofSubmitted(data.data);
        }
      } else {
        const res = await fetch(
          `${backendUrl}/fees/${createdAdvanceFee._id}/submit-utr`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              ...authHeaders,
            },
            body: JSON.stringify({
              utrNumber: cleanUtr,
              token,
            }),
          }
        );

        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || "Failed to submit advance UTR.");
        }
      }

      setShowAdvanceModal(false);
      setCreatedAdvanceFee(null);
      setAdvanceUtrInput("");
      setAdvanceProofFile(null);
      setAdvanceProofNotes("");
      setShowAdvanceProofForm(false);

      if (cleanUtr && onUtrSubmitted) {
        onUtrSubmitted(cleanUtr);
      }
      if (onAdvancePaymentSuccess) {
        onAdvancePaymentSuccess();
      } else if (onPaymentSuccess) {
        onPaymentSuccess();
      }
    } catch (err: unknown) {
      setAdvanceError(
        err instanceof Error ? err.message : "Failed to submit advance payment proof."
      );
    } finally {
      setIsSubmittingAdvanceProof(false);
    }
  };

  // =========================================================================
  // TASK 5: PAYMENT PROOF SCREENSHOT UPLOAD & CLIENT-SIDE VALIDATION
  // =========================================================================
  const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB

  const handleSelectProofFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setProofError(null);
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];

    // Client-side MIME type and extension check
    const normalizedType = (file.type || "").toLowerCase();
    const hasValidMime = ALLOWED_MIME_TYPES.includes(normalizedType);
    const hasValidExt = /\.(jpe?g|png|webp)$/i.test(file.name || "");

    if (!hasValidMime && !hasValidExt) {
      setProofError(
        "Only JPEG, PNG, and WebP images are supported. (PDF or other document formats are not accepted)"
      );
      return;
    }

    // Client-side file size check (3 MB max)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
      setProofError(
        `File exceeds the 3 MB limit (${sizeMb} MB). Please choose a smaller image or screenshot.`
      );
      return;
    }

    if (file.size === 0) {
      setProofError("The selected file is empty. Please choose a valid image.");
      return;
    }

    // Clean up previous preview object URL if any
    if (proofPreviewUrl) {
      URL.revokeObjectURL(proofPreviewUrl);
    }

    setSelectedProofFile(file);
    try {
      const preview = URL.createObjectURL(file);
      setProofPreviewUrl(preview);
    } catch {
      setProofPreviewUrl(null);
    }
  };

  const handleClearProofFile = () => {
    if (proofPreviewUrl) {
      URL.revokeObjectURL(proofPreviewUrl);
    }
    setSelectedProofFile(null);
    setProofPreviewUrl(null);
    setProofError(null);
  };

  const handleCloseProofModal = () => {
    if (isUploadingProof) return;
    setShowProofModal(false);
    handleClearProofFile();
    setProofUtrInput("");
    setProofNotesInput("");
    setProofError(null);
    setProofSuccess(false);
  };

  const handleSubmitProof = async (e: React.FormEvent) => {
    e.preventDefault();

    // If UTR was fetched from app, use that. When UTR is not fetched, manual UTR entry is removed.
    const cleanUtr = (detectedUtrFromApp && utrFetchStatus === "fetched")
      ? validateExtractedUtr(detectedUtrFromApp) || ""
      : "";
    const hasUtr = cleanUtr.length >= 6;
    const hasFile = Boolean(selectedProofFile);

    if (!hasUtr && !hasFile) {
      setProofError("UTR was not fetched. A payment screenshot is required to submit for verification.");
      return;
    }

    if (!feeId) {
      setProofError(
        "Fee record ID is missing. Please refresh the page and try again."
      );
      return;
    }

    setIsUploadingProof(true);
    setProofError(null);

    try {
      const backendUrl =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

      const token =
        typeof window !== "undefined"
          ? sessionStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("parent_portal_session_token") ||
            localStorage.getItem("auth_token")
          : null;

      const formData = new FormData();
      if (selectedProofFile) {
        formData.append("file", selectedProofFile);
      }

      if (cleanUtr) {
        formData.append("utrNumber", cleanUtr);
      }

      const cleanNotes = proofNotesInput.trim();
      if (cleanNotes) {
        formData.append("notes", cleanNotes);
      }

      if (token) {
        formData.append("token", token);
      }

      const authHeaders: Record<string, string> = {
        Accept: "application/json",
      };
      if (token) {
        authHeaders["Authorization"] = `Bearer ${token}`;
      }

      const res = await fetch(`${backendUrl}/fees/${feeId}/payment-proof`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders,
        body: formData,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        if (res.status === 401) {
          throw new Error(
            "Your session has expired. Please re-open your portal link from WhatsApp."
          );
        }
        if (res.status === 403) {
          throw new Error(
            data?.error ||
              "Access denied: You are not authorized to submit payment proofs for this student."
          );
        }
        if (res.status === 409) {
          throw new Error(
            data?.error ||
              "A payment proof was recently submitted or an upload is already in progress. Please wait a moment."
          );
        }
        if (res.status === 413) {
          throw new Error(
            "File exceeds the server limit of 3 MB. Please compress or select a smaller image."
          );
        }
        throw new Error(
          data?.error || "Failed to upload payment proof. Please try again."
        );
      }

      // Success: Transition card to Verification Pending without marking fee as Paid
      setProofSuccess(true);
      setCurrentStatus("Verification Pending");
      if (cleanUtr) {
        setSavedUtr(cleanUtr);
      }

      if (onProofSubmitted) {
        onProofSubmitted(data.data);
      }
      if (cleanUtr && onUtrSubmitted) {
        onUtrSubmitted(cleanUtr);
      }

      // Auto-close modal after brief visual celebration (2.5 seconds)
      setTimeout(() => {
        handleCloseProofModal();
        setShowUpiModal(false);
      }, 2500);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to upload payment proof. Please try again.";
      setProofError(msg);
    } finally {
      setIsUploadingProof(false);
    }
  };

  const handleCopyVpa = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(targetUpiId);
      setCopiedVpa(true);
      setTimeout(() => setCopiedVpa(false), 2000);
    }
  };

  return (
    <>
      {/* Advance Wallet Balance Banner */}
      {Number(advanceBalance) > 0 && (
        <div className="rounded-3xl border border-amber-200/90 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-amber-500/5 p-4.5 shadow-2xs space-y-2 mb-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-amber-800 flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-amber-600" />
              Smart Advance Wallet
            </span>
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-extrabold text-amber-800 border border-amber-200">
              Active Credit
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-2xl font-black font-mono text-amber-950">
              ₹{Number(advanceBalance).toLocaleString("en-IN")}
            </div>
            <span className="text-[11px] font-semibold text-amber-700 bg-amber-100/60 px-2 py-0.5 rounded-lg border border-amber-200/60">
              Auto-deducts on next bill
            </span>
          </div>
          <p className="text-[11px] text-amber-800/90 leading-relaxed font-medium">
            Your wallet credit will be automatically applied to your next monthly tuition fee. No manual action needed.
          </p>
        </div>
      )}

      {/* 1. PAID STATE */}
      {currentStatus === "Paid" ? (
        <div className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm space-y-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Fee Status
            </span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 border border-emerald-200/60">
              Paid &amp; Cleared
            </span>
          </div>

          <div>
            <div className="text-2xl font-extrabold text-emerald-700 font-mono">
              ₹0 Due
            </div>
            <p className="mt-0.5 text-xs text-slate-500 font-medium">
              Tuition fee received and cleared successfully. Official e-Receipt archived below.
            </p>
          </div>

          <div className="pt-0.5 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
            Official e-Receipt recorded in center database
          </div>

          {/* Secondary Action: Pay Advance */}
          <button
            type="button"
            onClick={() => {
              setCreatedAdvanceFee(null);
              setAdvancePaymentSuccess(false);
              setShowAdvanceModal(true);
            }}
            className="tap-bounce w-full h-10 rounded-2xl border border-emerald-300 bg-white hover:bg-emerald-50 active:scale-[0.98] text-emerald-800 font-bold text-xs flex items-center justify-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
            <span>Pay Next Month in Advance</span>
          </button>
        </div>
      ) : currentStatus === "Verification Pending" ? (
        /* 2. VERIFICATION PENDING STATE */
        <div className="rounded-3xl border-2 border-amber-300 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm space-y-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700 flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-amber-600" />
              Verification In Progress
            </span>
            <span className="rounded-full bg-amber-100 px-3 py-0.5 text-[11px] font-extrabold text-amber-800 border border-amber-200">
              Verification Pending
            </span>
          </div>

          <div>
            <div className="text-3xl font-extrabold text-amber-900 font-mono tracking-tight">
              ₹{amount.toLocaleString("en-IN")}
            </div>
            <p className="mt-1 text-xs text-amber-800 font-medium leading-relaxed">
              Payment submitted. Waiting for tuition center head to verify your
              payment with bank statement.
            </p>
          </div>

          <div className="p-3 rounded-2xl bg-white border border-amber-200 space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
              Submitted Reference Number
            </span>
            <div className="flex items-center justify-between font-mono font-bold text-xs text-slate-800">
              <span>{savedUtr || "Under Review"}</span>
              <span className="text-[10px] text-amber-700 font-sans font-semibold bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                Awaiting Admin Match
              </span>
            </div>
          </div>

          {/* Secondary Actions */}
          <div className="space-y-2 pt-1">
            <button
              type="button"
              onClick={() => setShowProofModal(true)}
              className="tap-bounce w-full h-10 rounded-2xl border border-amber-300 bg-white hover:bg-amber-50 active:scale-[0.98] text-amber-900 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Camera className="h-3.5 w-3.5 text-amber-700" />
              <span>Upload / Update Payment Screenshot</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCreatedAdvanceFee(null);
                setAdvancePaymentSuccess(false);
                setShowAdvanceModal(true);
              }}
              className="tap-bounce w-full h-10 rounded-2xl border border-amber-200 bg-amber-50/50 hover:bg-amber-100/60 active:scale-[0.98] text-amber-900 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-600" />
              <span>Pay Additional in Advance</span>
            </button>
          </div>
        </div>
      ) : (
        /* 3. PENDING / OVERDUE STATE */
        <div className="rounded-3xl border-2 border-rose-200/90 bg-gradient-to-br from-rose-50/70 via-white to-amber-50/50 p-5 shadow-sm space-y-3.5">
          {/* Header */}
          <div className="flex items-center justify-between">
            {currentStatus === "Partial Paid" ? (
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700 flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-amber-600 stroke-[2.3]" />
                Partial Paid • Remaining Balance
              </span>
            ) : (
              <span className="text-[11px] font-bold uppercase tracking-wider text-rose-600 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-rose-500 stroke-[2.3]" />
                Fee Due
              </span>
            )}
            {daysLate > 0 ? (
              <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-extrabold text-rose-700 border border-rose-200">
                {daysLate} {daysLate === 1 ? "Day" : "Days"} Late
              </span>
            ) : (
              <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-extrabold text-blue-700 border border-blue-200">
                Due: {dueDate}
              </span>
            )}
          </div>

          {/* Previous Rejection Alert Banner */}
          {rejectionReason && currentStatus === "Pending" && (
            <div className="rounded-2xl bg-rose-50 border border-rose-200 p-3 space-y-1 animate-fade-in">
              <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                <span>Previous Submission Rejected</span>
              </div>
              <p className="text-[11px] text-rose-700 font-medium leading-relaxed">
                Reason: &ldquo;{rejectionReason}&rdquo;. Please verify your receipt and submit a corrected screenshot below.
              </p>
            </div>
          )}

          {/* Amount */}
          <div>
            <div className="text-3xl font-extrabold text-rose-600 font-mono tracking-tight">
              ₹{amount.toLocaleString("en-IN")}
            </div>
            <p className="mt-1 text-[12px] font-medium text-slate-600">
              Tuition Fee • Due Date:{" "}
              <span className="font-bold text-slate-800">{dueDate}</span>
            </p>
          </div>

          {/* Action Buttons */}
          <div className="space-y-2 pt-1">
            <button
              type="button"
              disabled={gatewayPinging}
              onClick={handlePayFees}
              className="tap-bounce w-full h-12 rounded-2xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold text-[14px] shadow-md shadow-blue-600/30 flex items-center justify-center gap-2 transition-transform cursor-pointer disabled:opacity-80 disabled:cursor-not-allowed"
            >
              {gatewayPinging ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                  <span>Initializing Secure Payment Gateway...</span>
                </>
              ) : (
                <>
                  <QrCode className="h-4 w-4 stroke-[2.4]" />
                  <span>Pay Now (Dynamic QR / UPI)</span>
                </>
              )}
            </button>

            {gatewayError && (
              <p className="text-[11px] font-semibold text-rose-600 text-center animate-fade-in pt-0.5">
                {gatewayError}
              </p>
            )}

            <button
              type="button"
              onClick={() => setShowProofModal(true)}
              className="tap-bounce w-full h-11 rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50/90 to-blue-50/90 hover:from-indigo-100 hover:to-blue-100 active:scale-[0.98] text-indigo-900 font-bold text-xs flex items-center justify-center gap-2 shadow-2xs transition-all cursor-pointer"
            >
              <Camera className="h-4 w-4 text-indigo-600 stroke-[2.2]" />
              <span>Already Paid? Submit Payment Screenshot</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCreatedAdvanceFee(null);
                setAdvancePaymentSuccess(false);
                setShowAdvanceModal(true);
              }}
              className="tap-bounce w-full h-10 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 active:scale-[0.98] text-slate-700 font-bold text-xs flex items-center justify-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
            >
              <Sparkles className="h-3.5 w-3.5 text-blue-600" />
              <span>Pay in Advance</span>
            </button>
          </div>

          <p className="text-center text-[10px] text-slate-400 font-medium">
            Instant 0-fee payment via GPay, PhonePe, Paytm, or BHIM
          </p>
        </div>
      )}

      {/* ========================================================================= */}
      {/* REGULAR UPI PAYMENT GATEWAY MODAL (RAZORPAY STYLE POLLING + FALLBACK)     */}
      {/* ========================================================================= */}
      {showUpiModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-fade-in overflow-y-auto">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 sm:p-6 shadow-2xl space-y-4 border border-slate-200 my-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-black text-slate-900 tracking-tight">
                  UPI Payment Gateway
                </h3>
                <p className="text-[11px] text-slate-500 font-medium">
                  {centerName} • Direct Center Transfer
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowUpiModal(false)}
                className="tap-bounce h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* TASK 4: SUCCESS ANIMATION (Transition into large green checkmark, 3s auto close) */}
            {regularPaymentSuccess ? (
              <div className="py-10 px-4 flex flex-col items-center justify-center text-center space-y-4 animate-fade-in">
                <div className="relative flex items-center justify-center">
                  <div className="w-24 h-24 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-xl shadow-emerald-500/25 ring-8 ring-emerald-50 animate-in zoom-in-50 duration-500">
                    <CheckCircle2 className="w-14 h-14 stroke-[2.6] text-emerald-600 animate-in fade-in zoom-in duration-300" />
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200/80">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                    Verified Real-Time
                  </span>
                  <h3 className="text-2xl font-black text-slate-900 tracking-tight">
                    Payment Successful!
                  </h3>
                  <p className="text-xs text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">
                    Your tuition payment of ₹{amount.toLocaleString("en-IN")} has been verified and recorded.
                  </p>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs font-bold text-emerald-700 bg-emerald-50/80 border border-emerald-200/60 px-4 py-2 rounded-xl">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Closing and refreshing in 3 seconds...</span>
                </div>
              </div>
            ) : (
              <>
                {/* Payable Amount Box */}
                <div className="rounded-2xl bg-slate-50 p-3.5 text-center border border-slate-200/80 space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Total Amount Due
                  </span>
                  <div className="text-3xl font-extrabold text-slate-900 font-mono tracking-tight">
                    ₹{amount.toLocaleString("en-IN")}
                  </div>
                  <div className="flex items-center justify-center gap-1.5 pt-0.5">
                    <span className="text-[11px] font-mono text-blue-600 font-bold truncate max-w-[200px]">
                      {targetUpiId}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyVpa}
                      className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors cursor-pointer"
                      title="Copy UPI ID"
                    >
                      {copiedVpa ? (
                        <Check className="h-3 w-3 text-emerald-600" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>

                {/* METHOD 1: Dynamic Scannable QR Code */}
                <div className="flex flex-col items-center justify-center p-3.5 rounded-2xl border-2 border-dashed border-slate-200 bg-white">
                  <div className="p-2.5 bg-white rounded-2xl shadow-xs border border-slate-100 flex flex-col items-center">
                    <QRCodeSVG
                      value={upiLink}
                      size={170}
                      level="M"
                      includeMargin={true}
                      className="rounded-lg"
                    />
                  </div>
                  <p className="mt-2 text-xs font-bold text-slate-800 flex items-center gap-1">
                    <QrCode className="h-3.5 w-3.5 text-blue-600" />
                    <span>Scan via any UPI App</span>
                  </p>
                  <span className="text-[10px] text-slate-400 font-medium">
                    GPay • PhonePe • Paytm • BHIM • Banking Apps
                  </span>
                </div>

                {/* METHOD 2: 1-Tap Mobile Intent (Explicit Button Click to eliminate desktop auto-launch console error) */}
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={handleOpenUpiApp}
                    className="tap-bounce w-full h-12 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.98] text-white font-bold text-xs sm:text-sm shadow-md shadow-blue-500/25 flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <Smartphone className="h-4 w-4 stroke-[2.2]" />
                    <span>Pay via UPI App</span>
                    <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                  </button>
                  <p className="text-center text-[10px] text-slate-400">
                    (Tapping opens installed UPI app on your mobile device)
                  </p>
                </div>

                {/* TASK 1: RAZORPAY-STYLE PROCESSING UI WITH RADAR / PULSING ORBIT */}
                <div className="relative overflow-hidden rounded-2xl border border-blue-200/80 bg-gradient-to-br from-blue-50/90 via-indigo-50/40 to-white p-3.5 shadow-xs">
                  <div className="flex items-center gap-3.5 relative z-10">
                    <div className="relative flex items-center justify-center w-11 h-11 flex-shrink-0">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-20 animate-ping duration-1000"></span>
                      <span className="absolute inline-flex h-8 w-8 rounded-full bg-indigo-500 opacity-25 animate-pulse"></span>
                      <div className="relative flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white shadow-md shadow-blue-500/30">
                        <Loader2 className="w-3.5 h-3.5 animate-spin stroke-[2.5]" />
                      </div>
                    </div>

                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-xs font-black text-slate-900 tracking-tight">
                          Waiting for payment confirmation...
                        </h4>
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      </div>
                      <p className="text-[11px] font-medium text-slate-500 leading-snug">
                        Please do not close this window or press back.
                      </p>
                    </div>
                  </div>
                </div>

                {/* UNIFIED PAYMENT DETAILS CONFIRMATION & SUBMISSION */}
                <div className="pt-2 border-t border-slate-100 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-indigo-600" />
                      <span>Already Paid? Submit Details for Review</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowInModalSubmission(!showInModalSubmission)}
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-bold underline cursor-pointer"
                    >
                      {showInModalSubmission ? "Hide Form" : (detectedUtrFromApp && utrFetchStatus === "fetched" ? "Submit Fetched UTR / Screenshot" : "Submit Payment Screenshot")}
                    </button>
                  </div>

                  {upiAppError && (
                    <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-[11px] leading-tight flex items-start gap-1.5 animate-fade-in">
                      <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                      <span>{upiAppError}</span>
                    </div>
                  )}

                  {/* State 1: Actual UTR fetched */}
                  {detectedUtrFromApp && utrFetchStatus === "fetched" && (
                    <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs space-y-1.5 animate-fade-in">
                      <div className="flex items-center justify-between">
                        <span className="font-extrabold text-[11px] uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          UTR / Transaction ID
                        </span>
                        <span className="text-[10px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded-full font-bold">
                          Fetched
                        </span>
                      </div>
                      <div className="font-mono font-black text-sm text-emerald-950 bg-white/80 px-2.5 py-1.5 rounded-xl border border-emerald-200 select-all">
                        {detectedUtrFromApp}
                      </div>
                      <p className="text-[10px] text-emerald-700 font-medium">
                        Transaction reference fetched from UPI app. You may submit now for Owner verification, or attach an optional screenshot below.
                      </p>
                    </div>
                  )}

                  {/* State 2: UTR Not Fetched */}
                  {(!detectedUtrFromApp || utrFetchStatus === "not_fetched") && (
                    <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-1.5 animate-fade-in">
                      <div className="flex items-center justify-between">
                        <span className="font-extrabold text-[11px] uppercase tracking-wider text-amber-800 flex items-center gap-1.5">
                          <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                          Transaction Reference
                        </span>
                        <span className="text-[10px] bg-amber-200/80 text-amber-900 px-2 py-0.5 rounded-full font-bold">
                          UTR Not Fetched
                        </span>
                      </div>
                      <p className="text-[11px] text-amber-800 font-medium leading-relaxed">
                        Your UPI app did not return a transaction reference. A payment screenshot is required to submit for verification.
                      </p>
                    </div>
                  )}

                  {(showInModalSubmission || regularDelayedButtonVisible) ? (
                    <form onSubmit={handleSubmitProof} className="space-y-3 animate-fade-in p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80">
                      {/* State 3: Screenshot Uploaded Status (if selected) */}
                      {selectedProofFile && (
                        <div className="p-2.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-900 text-xs space-y-1 animate-fade-in">
                          <div className="flex items-center justify-between">
                            <span className="font-extrabold text-[11px] uppercase tracking-wider text-indigo-800 flex items-center gap-1.5">
                              <FileImage className="w-3.5 h-3.5 text-indigo-600" />
                              Payment Screenshot Uploaded
                            </span>
                            <span className="text-[10px] bg-indigo-200/80 text-indigo-900 px-2 py-0.5 rounded-full font-bold">
                              Ready
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Screenshot Picker */}
                      <div className="space-y-1">
                        <label className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                          <span>Payment Screenshot</span>
                          <span className={`text-[10px] font-bold ${detectedUtrFromApp && utrFetchStatus === "fetched" ? "text-slate-400 font-normal" : "text-amber-700"}`}>
                            {detectedUtrFromApp && utrFetchStatus === "fetched" ? "Optional (UTR Fetched)" : "Required (UTR Not Fetched)"}
                          </span>
                        </label>

                        {!selectedProofFile ? (
                          <label className="flex items-center justify-center gap-2 py-2 px-3 border border-dashed border-indigo-200 rounded-xl bg-indigo-50/40 hover:bg-indigo-50/70 text-indigo-700 text-xs font-semibold cursor-pointer transition-colors">
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              capture="environment"
                              onChange={handleSelectProofFile}
                              className="hidden"
                              disabled={isUploadingProof}
                            />
                            <Camera className="w-3.5 h-3.5 text-indigo-600" />
                            <span>Attach Screenshot (JPG, PNG, WebP)</span>
                          </label>
                        ) : (
                          <div className="flex items-center justify-between p-2 rounded-xl bg-white border border-indigo-200 text-xs">
                            <span className="font-semibold text-slate-700 truncate max-w-[180px]">
                              {selectedProofFile.name} ({(selectedProofFile.size / 1024).toFixed(0)} KB)
                            </span>
                            <button
                              type="button"
                              onClick={handleClearProofFile}
                              className="text-rose-600 hover:text-rose-800 p-1 cursor-pointer"
                              title="Remove Screenshot"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Warning if no UTR and no screenshot provided */}
                      {(!detectedUtrFromApp || utrFetchStatus !== "fetched") && !selectedProofFile && (
                        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-2 font-medium">
                          A payment screenshot is required before submitting.
                        </p>
                      )}

                      {proofError && (
                        <p className="text-[11px] text-rose-600 font-semibold">{proofError}</p>
                      )}

                      <button
                        type="submit"
                        disabled={isUploadingProof || ((!detectedUtrFromApp || utrFetchStatus !== "fetched") && !selectedProofFile)}
                        className="tap-bounce w-full h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all disabled:opacity-50 cursor-pointer"
                      >
                        {isUploadingProof ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span>Submitting Payment Details...</span>
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>
                              {detectedUtrFromApp && utrFetchStatus === "fetched"
                                ? (selectedProofFile ? "Submit UTR & Screenshot for Review" : "Submit Fetched UTR for Review")
                                : "Submit Payment Screenshot for Review"}
                            </span>
                          </>
                        )}
                      </button>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <button
                        type="button"
                        onClick={() => setShowInModalSubmission(true)}
                        className="tap-bounce w-full py-2.5 px-3 rounded-xl bg-indigo-50 hover:bg-indigo-100/80 active:scale-[0.98] text-indigo-900 text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer border border-indigo-200/60"
                      >
                        <Camera className="w-3.5 h-3.5 text-indigo-600 stroke-[2.2]" />
                        <span>Paid via UPI / QR? Submit Details</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ADVANCE FEE PAYMENT MODAL (RAZORPAY STYLE POLLING + FALLBACK)             */}
      {/* ========================================================================= */}
      {showAdvanceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-fade-in overflow-y-auto">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 sm:p-6 shadow-2xl space-y-4 border border-slate-200 my-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-200">
                  <CreditCard className="h-4 w-4 stroke-[2.2]" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 tracking-tight">
                    Pay in Advance
                  </h3>
                  <p className="text-[11px] text-slate-500 font-medium">
                    {centerName} • Advance Fee Payment
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAdvanceModal(false);
                  setCreatedAdvanceFee(null);
                  setAdvancePaymentSuccess(false);
                }}
                className="tap-bounce h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* TASK 4: ADVANCE PAYMENT SUCCESS ANIMATION */}
            {advancePaymentSuccess ? (
              <div className="py-10 px-4 flex flex-col items-center justify-center text-center space-y-4 animate-fade-in">
                <div className="relative flex items-center justify-center">
                  <div className="w-24 h-24 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-xl shadow-emerald-500/25 ring-8 ring-emerald-50 animate-in zoom-in-50 duration-500">
                    <CheckCircle2 className="w-14 h-14 stroke-[2.6] text-emerald-600 animate-in fade-in zoom-in duration-300" />
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200/80">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                    Advance Confirmed
                  </span>
                  <h3 className="text-2xl font-black text-slate-900 tracking-tight">
                    Payment Successful!
                  </h3>
                  <p className="text-xs text-slate-500 font-medium max-w-xs mx-auto leading-relaxed">
                    Your advance tuition fee payment of ₹{createdAdvanceFee?.amountDue.toLocaleString("en-IN")} has been verified and cleared.
                  </p>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs font-bold text-emerald-700 bg-emerald-50/80 border border-emerald-200/60 px-4 py-2 rounded-xl">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Closing and refreshing in 3 seconds...</span>
                </div>
              </div>
            ) : !createdAdvanceFee ? (
              /* STEP 1: Enter Advance Amount */
              <div className="space-y-3">
                <label className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                  <span>Enter Advance Amount (₹)</span>
                  <span className="text-[10px] font-medium text-slate-400">
                    Must be &gt; ₹0
                  </span>
                </label>

                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                    <IndianRupee className="h-4 w-4" />
                  </div>
                  <input
                    type="number"
                    min="1"
                    step="100"
                    value={advanceAmountInput}
                    onChange={(e) => {
                      setAdvanceAmountInput(e.target.value);
                      if (advanceError) setAdvanceError(null);
                    }}
                    placeholder="e.g. 3000"
                    className="w-full pl-9 pr-3.5 py-2.5 text-base font-mono font-extrabold text-slate-900 rounded-xl border border-slate-200 bg-slate-50/70 focus:bg-white focus:outline-hidden focus:ring-4 focus:ring-amber-100 focus:border-amber-500 transition-all"
                  />
                </div>

                {/* Quick Select Amount Pills */}
                <div className="flex items-center gap-1.5 pt-0.5">
                  {QUICK_ADVANCE_AMOUNTS.map((quickAmt) => (
                    <button
                      key={quickAmt}
                      type="button"
                      onClick={() => {
                        setAdvanceAmountInput(String(quickAmt));
                        if (advanceError) setAdvanceError(null);
                      }}
                      className={`tap-bounce flex-1 py-1 rounded-lg text-[11px] font-bold font-mono transition-all border cursor-pointer ${
                        Number(advanceAmountInput) === quickAmt
                          ? "bg-amber-500 text-white border-amber-600 shadow-2xs"
                          : "bg-slate-100 text-slate-700 border-slate-200/80 hover:bg-slate-200/60"
                      }`}
                    >
                      ₹{quickAmt.toLocaleString("en-IN")}
                    </button>
                  ))}
                </div>

                {advanceError && (
                  <p className="text-[11px] text-rose-600 font-semibold">
                    {advanceError}
                  </p>
                )}

                <button
                  type="button"
                  onClick={handleInitiateAdvancePayment}
                  disabled={advanceCreating || numericAdvance <= 0}
                  className="tap-bounce w-full h-12 rounded-2xl bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-white font-bold text-sm shadow-md shadow-amber-500/25 flex items-center justify-center gap-2 transition-all disabled:opacity-50 mt-2 cursor-pointer"
                >
                  {advanceCreating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                      <span>Generating Secure Payment QR...</span>
                    </>
                  ) : (
                    <>
                      <QrCode className="h-4 w-4 stroke-[2.2]" />
                      <span>Proceed to Pay ₹{numericAdvance.toLocaleString("en-IN")}</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              /* STEP 2: Scannable QR & 1-Tap Deep Link with Real-Time Polling */
              <div className="space-y-3.5 animate-fade-in">
                {/* Advance Amount Summary Box */}
                <div className="rounded-2xl bg-amber-50/80 p-3 text-center border border-amber-200 space-y-1">
                  <div className="flex items-center justify-between text-[10px] font-bold text-amber-800">
                    <span>Advance Payment</span>
                    <button
                      type="button"
                      onClick={() => setCreatedAdvanceFee(null)}
                      className="text-amber-700 underline hover:text-amber-900 cursor-pointer"
                    >
                      Change Amount
                    </button>
                  </div>
                  <div className="text-3xl font-extrabold text-amber-900 font-mono tracking-tight">
                    ₹{createdAdvanceFee.amountDue.toLocaleString("en-IN")}
                  </div>
                  <span className="text-[11px] font-mono text-amber-800 font-bold block truncate">
                    {targetUpiId}
                  </span>
                </div>

                {/* Method 1: Desktop Scannable QR Code */}
                <div className="flex flex-col items-center justify-center p-3 rounded-2xl border-2 border-dashed border-amber-200 bg-white">
                  <div className="p-2 bg-white rounded-2xl shadow-xs border border-amber-100 flex flex-col items-center">
                    <QRCodeSVG
                      value={advanceUpiLink}
                      size={155}
                      level="M"
                      includeMargin={true}
                      className="rounded-lg"
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] font-bold text-slate-800 flex items-center gap-1">
                    <QrCode className="h-3 w-3 text-amber-600" />
                    <span>Scan via any UPI App</span>
                  </p>
                  <span className="text-[10px] text-slate-400">
                    GPay • PhonePe • Paytm • BHIM
                  </span>
                </div>

                {/* Method 2: Mobile 1-Tap Deep Link Button (Click handler only) */}
                <button
                  type="button"
                  onClick={handleOpenAdvanceUpiApp}
                  className="tap-bounce w-full h-11 rounded-2xl bg-gradient-to-r from-amber-500 via-amber-600 to-amber-700 hover:from-amber-600 hover:to-amber-700 active:scale-[0.98] text-white font-bold text-xs sm:text-sm shadow-md shadow-amber-500/25 flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  <Smartphone className="h-4 w-4 stroke-[2.2]" />
                  <span>Pay ₹{createdAdvanceFee.amountDue.toLocaleString("en-IN")} via UPI App</span>
                  <ExternalLink className="h-3.5 w-3.5 opacity-80" />
                </button>

                {/* TASK 1: RAZORPAY-STYLE PROCESSING UI WITH RADAR / PULSING ORBIT */}
                <div className="relative overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50/90 via-orange-50/40 to-white p-3.5 shadow-xs">
                  <div className="flex items-center gap-3.5 relative z-10">
                    <div className="relative flex items-center justify-center w-11 h-11 flex-shrink-0">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-20 animate-ping duration-1000"></span>
                      <span className="absolute inline-flex h-8 w-8 rounded-full bg-amber-600 opacity-25 animate-pulse"></span>
                      <div className="relative flex items-center justify-center w-6 h-6 rounded-full bg-amber-600 text-white shadow-md shadow-amber-500/30">
                        <Loader2 className="w-3.5 h-3.5 animate-spin stroke-[2.5]" />
                      </div>
                    </div>

                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-xs font-black text-slate-900 tracking-tight">
                          Waiting for payment confirmation...
                        </h4>
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      </div>
                      <p className="text-[11px] font-semibold text-slate-500 leading-snug">
                        Please do not close this window or press back.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Manual Fallback & Payment Proof Submission */}
                {!showAdvanceProofForm ? (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAdvanceProofForm(true)}
                      className="tap-bounce w-full py-2.5 px-3 rounded-2xl bg-amber-500/10 hover:bg-amber-500/20 active:scale-[0.98] text-amber-950 text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer border border-amber-300 shadow-2xs"
                    >
                      <Camera className="w-4 h-4 text-amber-700 stroke-[2.2]" />
                      <span>Submit Payment Proof / I have paid</span>
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleSubmitAdvanceProof} className="space-y-3 pt-2.5 border-t border-amber-200/80 bg-amber-50/70 p-3.5 rounded-2xl animate-fade-in">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                        <Camera className="h-3.5 w-3.5 text-amber-700" />
                        <span>Payment Proof & Verification</span>
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          setShowAdvanceProofForm(false);
                          if (advanceError) setAdvanceError(null);
                        }}
                        className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-600 leading-tight">
                      Attach your payment screenshot or enter the transaction reference from your UPI app.
                    </p>

                    {/* Screenshot File Picker */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                        <span>Payment Screenshot</span>
                        <span className="text-[10px] font-normal text-slate-400">
                          JPG, PNG, WebP (Max 3 MB)
                        </span>
                      </label>

                      {!advanceProofFile ? (
                        <label className="flex items-center justify-center gap-2 py-2.5 px-3 border border-dashed border-amber-300 rounded-xl bg-white hover:bg-amber-50/50 text-amber-900 text-xs font-semibold cursor-pointer transition-colors shadow-2xs">
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            capture="environment"
                            onChange={handleSelectAdvanceProofFile}
                            className="hidden"
                            disabled={isSubmittingAdvanceProof}
                          />
                          <Camera className="w-3.5 h-3.5 text-amber-600" />
                          <span>Attach Screenshot</span>
                        </label>
                      ) : (
                        <div className="flex items-center justify-between p-2 rounded-xl bg-white border border-amber-200 text-xs">
                          <span className="font-semibold text-slate-800 truncate max-w-[200px]">
                            {advanceProofFile.name} ({(advanceProofFile.size / 1024).toFixed(0)} KB)
                          </span>
                          <button
                            type="button"
                            onClick={handleClearAdvanceProofFile}
                            className="text-rose-600 hover:text-rose-800 p-1 cursor-pointer"
                            title="Remove Screenshot"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* UTR Input */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                        <span>UTR / Ref No.</span>
                        <span className="text-[10px] font-normal text-slate-400">
                          {advanceProofFile ? "Optional if screenshot attached" : "Required if no screenshot"}
                        </span>
                      </label>
                      <input
                        type="text"
                        maxLength={22}
                        value={advanceUtrInput}
                        onChange={(e) => {
                          setAdvanceUtrInput(e.target.value.trim().toUpperCase());
                          if (advanceError) setAdvanceError(null);
                        }}
                        placeholder="e.g. 428910293847"
                        className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-mono font-bold text-slate-900 placeholder:text-slate-400 placeholder:font-normal focus:outline-hidden focus:ring-2 focus:ring-amber-200"
                      />
                    </div>

                    {advanceError && (
                      <p className="text-[11px] text-rose-600 font-semibold bg-rose-50 border border-rose-200 p-2 rounded-xl">
                        {advanceError}
                      </p>
                    )}

                    <button
                      type="submit"
                      disabled={isSubmittingAdvanceProof || (!advanceProofFile && !advanceUtrInput.trim())}
                      className="tap-bounce w-full h-10 rounded-xl bg-amber-600 hover:bg-amber-700 active:scale-[0.98] text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmittingAdvanceProof ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                          <span>Submitting Advance Proof...</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 stroke-[2.2]" />
                          <span>Submit Advance Proof for Review</span>
                        </>
                      )}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PAYMENT PROOF SUBMISSION MODAL (IMAGEKIT UPLOAD WITH LIVE PREVIEW)       */}
      {/* ========================================================================= */}
      {showProofModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-fade-in overflow-y-auto">
          <div className="w-full max-w-sm sm:max-w-md rounded-3xl bg-white p-5 sm:p-6 shadow-2xl space-y-4 border border-slate-200 my-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-200/80 shadow-2xs">
                  <Camera className="h-5 w-5 stroke-[2.2]" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 tracking-tight">
                    Submit Payment Proof
                  </h3>
                  <p className="text-[11px] text-slate-500 font-medium">
                    {centerName} • Verification Upload
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseProofModal}
                disabled={isUploadingProof}
                className="tap-bounce h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* SUCCESS VIEW (Animated celebration + clear "Verification Pending" clarification) */}
            {proofSuccess ? (
              <div className="py-8 px-2 flex flex-col items-center justify-center text-center space-y-4 animate-fade-in">
                <div className="relative flex items-center justify-center">
                  <div className="w-20 h-20 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-xl shadow-emerald-500/25 ring-8 ring-emerald-50 animate-in zoom-in-50 duration-500">
                    <CheckCircle2 className="w-12 h-12 stroke-[2.6] text-emerald-600" />
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-200">
                    <Clock className="w-3.5 h-3.5 text-amber-600" />
                    Verification Pending
                  </span>
                  <h3 className="text-xl font-black text-slate-900 tracking-tight">
                    Proof Submitted Successfully!
                  </h3>
                  <p className="text-xs text-slate-600 font-medium max-w-xs mx-auto leading-relaxed">
                    Payment proof submitted. Center staff will verify your payment against bank records.
                  </p>
                </div>

                <div className="rounded-2xl bg-amber-50/70 border border-amber-200/80 p-3 text-left w-full space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                    <ShieldCheck className="w-4 h-4 text-amber-700" />
                    <span>Important Invariant</span>
                  </div>
                  <p className="text-[11px] text-amber-800 font-medium leading-relaxed">
                    Your fee status is updated to <strong>Verification Pending</strong>. Your official e-Receipt will be issued once the center confirms receipt.
                  </p>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs font-bold text-slate-600 bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />
                  <span>Closing window in a moment...</span>
                </div>
              </div>
            ) : (
              /* UPLOAD FORM */
              <form onSubmit={handleSubmitProof} className="space-y-4">
                {/* Fee Context Summary */}
                <div className="rounded-2xl bg-slate-50 p-3 border border-slate-200/80 flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Amount to Verify
                    </span>
                    <div className="text-xl font-extrabold text-slate-900 font-mono">
                      ₹{amount.toLocaleString("en-IN")}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                      Due Date
                    </span>
                    <span className="text-xs font-bold text-slate-700 font-mono">
                      {dueDate}
                    </span>
                  </div>
                </div>

                {/* File Upload Zone / Live Preview */}
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                    <span>Payment Screenshot or Photo (Optional if UTR provided)</span>
                    <span className="text-[10px] font-medium text-slate-400">
                      JPG, PNG, WebP (Max 3 MB)
                    </span>
                  </label>

                  {!selectedProofFile ? (
                    /* Dropzone / File Picker */
                    <label className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-indigo-200 rounded-2xl bg-indigo-50/30 hover:bg-indigo-50/60 active:bg-indigo-100/50 transition-colors cursor-pointer group">
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        capture="environment"
                        onChange={handleSelectProofFile}
                        className="hidden"
                        disabled={isUploadingProof}
                      />
                      <div className="h-12 w-12 rounded-2xl bg-indigo-100 text-indigo-600 flex items-center justify-center mb-2.5 group-hover:scale-105 transition-transform shadow-2xs">
                        <UploadCloud className="h-6 w-6 stroke-[2.2]" />
                      </div>
                      <span className="text-xs font-bold text-slate-800 text-center">
                        Tap to choose screenshot or photo
                      </span>
                      <span className="text-[10px] text-slate-500 text-center mt-1">
                        From gallery, files, or camera on mobile
                      </span>
                    </label>
                  ) : (
                    /* Image Preview Card */
                    <div className="rounded-2xl border border-indigo-200 bg-slate-50 p-3 space-y-3 animate-fade-in">
                      <div className="relative rounded-xl overflow-hidden bg-slate-900 flex items-center justify-center max-h-56">
                        {proofPreviewUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={proofPreviewUrl}
                            alt="Payment Proof Preview"
                            className="max-h-56 w-auto object-contain rounded-lg"
                          />
                        ) : (
                          <div className="py-12 text-slate-400 flex flex-col items-center gap-1">
                            <FileImage className="h-8 w-8" />
                            <span className="text-xs">Image Loaded</span>
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={handleClearProofFile}
                          disabled={isUploadingProof}
                          className="absolute top-2 right-2 h-7 w-7 rounded-full bg-black/70 hover:bg-black text-white flex items-center justify-center transition-colors cursor-pointer shadow-md disabled:opacity-50"
                          title="Remove Image"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <div className="min-w-0 pr-2">
                          <p className="font-bold text-slate-800 truncate text-[11px]">
                            {selectedProofFile.name}
                          </p>
                          <p className="text-[10px] text-slate-500 font-medium">
                            {(selectedProofFile.size / 1024).toFixed(0)} KB •{" "}
                            {selectedProofFile.type.replace("image/", "").toUpperCase()}
                          </p>
                        </div>
                        <label className="tap-bounce py-1 px-2.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-[11px] font-bold text-slate-700 cursor-pointer transition-colors shrink-0">
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            capture="environment"
                            onChange={handleSelectProofFile}
                            className="hidden"
                            disabled={isUploadingProof}
                          />
                          Change
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                {/* State 1: Fetched UTR banner if available */}
                {detectedUtrFromApp && utrFetchStatus === "fetched" && (
                  <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs space-y-1 animate-fade-in">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[11px] uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        UTR / Transaction ID
                      </span>
                      <span className="text-[10px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded-full font-bold">
                        Fetched
                      </span>
                    </div>
                    <div className="font-mono font-black text-sm text-emerald-950 bg-white/80 px-2.5 py-1.5 rounded-xl border border-emerald-200 select-all">
                      {detectedUtrFromApp}
                    </div>
                    <p className="text-[10px] text-emerald-700 font-medium">
                      Transaction reference fetched from UPI app. You may submit now for Owner verification, or attach an optional screenshot above.
                    </p>
                  </div>
                )}

                {/* State 2: UTR Not Fetched Banner if not fetched */}
                {(!detectedUtrFromApp || utrFetchStatus === "not_fetched") && (
                  <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-1.5 animate-fade-in">
                    <div className="flex items-center justify-between">
                      <span className="font-extrabold text-[11px] uppercase tracking-wider text-amber-800 flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                        Transaction Reference
                      </span>
                      <span className="text-[10px] bg-amber-200/80 text-amber-900 px-2 py-0.5 rounded-full font-bold">
                        UTR Not Fetched
                      </span>
                    </div>
                    <p className="text-[11px] text-amber-800 font-medium leading-relaxed">
                      Your UPI app did not return a transaction reference. A payment screenshot is required to submit for verification.
                    </p>
                  </div>
                )}

                {/* Optional Notes Field */}
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                    <span>Note to Center (Optional)</span>
                    <span className="text-[10px] font-normal text-slate-400">
                      e.g. Paid via Dad&apos;s GPay
                    </span>
                  </label>
                  <input
                    type="text"
                    maxLength={100}
                    value={proofNotesInput}
                    onChange={(e) => setProofNotesInput(e.target.value)}
                    placeholder="e.g. Paid from father&apos;s account"
                    disabled={isUploadingProof}
                    className="w-full px-3.5 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50/70 focus:bg-white focus:outline-hidden focus:ring-4 focus:ring-indigo-100 focus:border-indigo-600 text-slate-900 placeholder:text-slate-400 text-xs transition-all"
                  />
                </div>

                {/* Warning if no UTR and no screenshot is provided */}
                {(!detectedUtrFromApp || utrFetchStatus !== "fetched") && !selectedProofFile && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-2.5 font-medium text-center">
                    A payment screenshot is required before submitting.
                  </p>
                )}

                {/* Error Banner */}
                {proofError && (
                  <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2 text-rose-700 animate-fade-in">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span className="text-xs font-semibold leading-snug">
                      {proofError}
                    </span>
                  </div>
                )}

                {/* Submit Action Button */}
                <button
                  type="submit"
                  disabled={isUploadingProof || ((!detectedUtrFromApp || utrFetchStatus !== "fetched") && !selectedProofFile)}
                  className="tap-bounce w-full h-12 rounded-2xl bg-gradient-to-r from-indigo-600 via-blue-600 to-indigo-700 hover:from-indigo-700 hover:to-blue-700 active:scale-[0.98] text-white font-bold text-xs sm:text-sm shadow-md shadow-indigo-500/25 flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isUploadingProof ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                      <span>Uploading Payment Details...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 stroke-[2.2]" />
                      <span>Submit Payment Details for Review</span>
                    </>
                  )}
                </button>

                <p className="text-center text-[10px] text-slate-400 font-medium leading-relaxed">
                  Submitting payment details sets status to Verification Pending. Center head verifies payment before clearing fee.
                </p>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
