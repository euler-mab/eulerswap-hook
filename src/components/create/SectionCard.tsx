"use client";

import { useState } from "react";

interface Props {
  title: string;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}

export default function SectionCard({ title, defaultOpen = true, badge, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-t border-gray-300 pt-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between group"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-widest text-gray-400 group-hover:text-gray-600 transition-colors">
            {title}
          </h2>
          {badge && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
              {badge}
            </span>
          )}
        </div>
        <span className="text-gray-400 text-xs transition-transform" style={{ transform: open ? "rotate(0)" : "rotate(-90deg)" }}>
          ▼
        </span>
      </button>
      {open && <div className="mt-4">{children}</div>}
    </section>
  );
}
