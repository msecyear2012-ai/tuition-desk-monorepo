import { redirect } from "next/navigation";

export default function HandoversRedirectPage() {
  redirect("/fees?tab=handovers");
}
