import { redirect } from "next/navigation";

// The playbook is now Rules.
export default async function PlaybookRedirect({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  redirect(`/merchant/${merchantId}/rules`);
}
