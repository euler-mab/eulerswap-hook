"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Explorer" },
  { href: "/create", label: "Create" },
  { href: "/pools", label: "Pools" },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="max-w-7xl mx-auto px-8 flex items-center h-14 justify-between">
        <Link href="/" className="text-lg font-semibold tracking-tight text-gray-900">
          EulerSwap
        </Link>

        <div className="flex items-center gap-6">
          {LINKS.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`text-sm transition-colors ${
                  active
                    ? "font-semibold text-gray-900"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
