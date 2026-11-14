import { NextRequest } from "next/server.js";
import { handleCorsPreflight } from "../../../../../lib/cors.ts";
import { handleDisputeResolution } from "../resolve/route.ts";

export async function OPTIONS(request: NextRequest) {
  return handleCorsPreflight(request, "POST, PUT, OPTIONS");
}

async function handleIncrementalSettlement(
  request: NextRequest,
  context: { params: Promise<{ handoverId: string }> }
) {
  // Read body and map amountReceived / amount to resolutionType: "cash_received"
  const body = await request.json().catch(() => ({}));
  const amount = body.amountReceived ?? body.amount;

  return handleDisputeResolution(request, context, {
    ...body,
    resolutionType: "cash_received",
    amount,
  });
}

export { handleIncrementalSettlement as POST, handleIncrementalSettlement as PUT };
