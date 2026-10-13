import { redirect } from "next/navigation";
import { merchantParam } from "../merchant";

// Keep the old deep link useful now that the guided story lives in the shared
// shell. This route used to render a stale placeholder outside the real demo.
export default async function DemoPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await merchantParam(params);
  redirect(`/merchant/${merchantId}?guided=1&step=1`);
}
