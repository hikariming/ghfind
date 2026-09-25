"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function InstallCommand({ command, label, copiedLabel }: { command: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return <button type="button" className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" onClick={() => void copy()} aria-label={copied ? copiedLabel : label}>
    {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
    {copied ? copiedLabel : label}
  </button>;
}
