import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { internationalSimView } from "@/flows/international/sim-actions";
import { InternationalSim } from "@/flows/international/ui/international-sim";

export default async function InternationalSimPage() {
  await connection();
  return <InternationalSim view={internationalSimView(getAdapters())} />;
}
