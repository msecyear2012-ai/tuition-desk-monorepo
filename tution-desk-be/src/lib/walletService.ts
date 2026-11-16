import Student from "../models/Student.ts";
import Fee from "../models/Fee.ts";

export interface CreditAdvanceWalletParams {
  centerId: string;
  studentId: string;
  amount: number;
  feeId?: string;
}

export interface CreditAdvanceWalletResult {
  success: boolean;
  creditedAmount: number;
  newBalance?: number;
  error?: string;
  alreadyCredited?: boolean;
}

/**
 * Credits verified advance payment to the student's smart advance wallet.
 * Uses atomic MongoDB operations with idempotency guard via fee.walletRechargeCredited.
 */
export async function creditAdvanceToStudentWallet(
  params: CreditAdvanceWalletParams
): Promise<CreditAdvanceWalletResult> {
  const { centerId, studentId, amount, feeId } = params;

  if (!amount || amount <= 0) {
    return { success: false, creditedAmount: 0, error: "Invalid credit amount" };
  }

  // Idempotency check if feeId is supplied
  if (feeId) {
    const fee = await Fee.findOne({ _id: feeId, centerId });
    if (!fee) {
      return { success: false, creditedAmount: 0, error: "Fee record not found" };
    }
    if (fee.walletRechargeCredited) {
      return {
        success: true,
        creditedAmount: 0,
        alreadyCredited: true,
      };
    }
  }

  // Atomically increment student's advanceBalance
  const updatedStudent = await Student.findOneAndUpdate(
    { _id: studentId, centerId },
    { $inc: { advanceBalance: amount } },
    { new: true }
  );

  if (!updatedStudent) {
    return { success: false, creditedAmount: 0, error: "Student record not found for center" };
  }

  // Mark fee as credited to prevent duplicate wallet balance increments
  if (feeId) {
    await Fee.updateOne(
      { _id: feeId, centerId },
      { $set: { walletRechargeCredited: true } }
    );
  }

  return {
    success: true,
    creditedAmount: amount,
    newBalance: updatedStudent.advanceBalance || 0,
  };
}
