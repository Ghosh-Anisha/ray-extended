import { SimulatedTag } from "../bits";

export function SimTitle({ children }: { children: string }) {
  return (
    <div className="sim-head">
      <h1 className="page-title">{children}</h1>
      <SimulatedTag />
    </div>
  );
}
