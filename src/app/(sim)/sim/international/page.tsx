import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { internationalSimView } from "@/flows/international/sim-actions";
import { InternationalSim } from "@/flows/international/ui/international-sim";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function InternationalSimPage() {
  await connection();
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Checkout abroad" }]} />
      <InternationalSim view={internationalSimView(getAdapters())} />
    </>
  );
}
