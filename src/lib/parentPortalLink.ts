import { apiClient } from "@/lib/apiClient";

interface ParentAccessLinkResponse {
  success?: boolean;
  exists?: boolean;
  portalUrl?: string | null;
  data?: {
    success?: boolean;
    exists?: boolean;
    portalUrl?: string | null;
  } | null;
}

/**
 * Opens the Parent Portal for a student using the canonical activation link.
 *
 * The Parent Portal has a single supported entry point: `/portal#token=pt_...`,
 * which exchanges the token for an HttpOnly parent session cookie. The clean URL
 * `/p/{studentId}` carries no credential and therefore returns
 * "Authentication required: Active parent session or token required" for any
 * parent who has not already activated — so it must never be used as a link.
 *
 * The backend returns the SAME link the parent already holds (decrypted from the
 * ParentAccess record) without rotating the token.
 */
export async function openParentPortalForStudent(
  studentId: string
): Promise<{ opened: boolean; message?: string }> {
  try {
    const res = await apiClient<ParentAccessLinkResponse>("/parent/access", {
      params: { studentId },
      skipCache: true,
    });

    const flat = res as unknown as ParentAccessLinkResponse;
    const data = (res?.data as ParentAccessLinkResponse["data"]) || flat;
    const portalUrl =
      (data?.portalUrl && String(data.portalUrl)) ||
      (flat?.portalUrl && String(flat.portalUrl)) ||
      "";

    if (!portalUrl) {
      return {
        opened: false,
        message:
          "No active Parent Portal link exists yet. Use the Parent Portal Access card on the student profile to generate one.",
      };
    }

    window.open(portalUrl, "_blank", "noopener,noreferrer");
    return { opened: true };
  } catch (err: unknown) {
    return {
      opened: false,
      message:
        err instanceof Error
          ? err.message
          : "Unable to open the Parent Portal link.",
    };
  }
}