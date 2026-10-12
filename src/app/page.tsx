import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>RAY</h1>
      <ul>
        <li>
          <Link href="/merchant">Merchant</Link>
        </li>
        <li>
          <Link href="/sim/inbox">Customer inbox</Link>
        </li>
        <li>
          <Link href="/dev">Dev panel</Link>
        </li>
      </ul>
    </main>
  );
}
