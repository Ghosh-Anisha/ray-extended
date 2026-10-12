import Link from "next/link";

export default function Home() {
  return (
    <main className="page stack">
      <h1>RAY</h1>
      <ul>
        <li>
          <Link href="/merchant">Merchant view</Link>
        </li>
        <li>
          <Link href="/sim/inbox">Customer inbox</Link> (Simulated)
        </li>
        <li>
          <Link href="/sim/buyers">Buyer inbox</Link> (Simulated)
        </li>
        <li>
          <Link href="/sim/store">Store admin</Link> (Simulated)
        </li>
        <li>
          <Link href="/sim/calls">Calls</Link> (Simulated)
        </li>
        <li>
          <Link href="/dev">Dev panel</Link> (Simulated)
        </li>
      </ul>
    </main>
  );
}
