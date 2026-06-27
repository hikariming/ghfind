"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

export interface ByoKeyConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export const BYO_STORAGE_KEY = "gh-roast-byo";

export function loadByoKey(): ByoKeyConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(BYO_STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as ByoKeyConfig;
    return cfg.apiKey && cfg.baseURL && cfg.model ? cfg : null;
  } catch {
    return null;
  }
}

const PRESETS: { label: string; baseURL: string; model: string }[] = [
  { label: "StepFun 阶跃", baseURL: "https://api.stepfun.com/v1", model: "step-3.7-flash" },
  { label: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat-v3-0324" },
  { label: "Groq", baseURL: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
];

export function ByoKeyModal({
  open,
  reason,
  onClose,
  onSave,
}: {
  open: boolean;
  reason?: string;
  onClose: () => void;
  onSave: (cfg: ByoKeyConfig | null) => void;
}) {
  const t = useTranslations("byok");
  const existing = loadByoKey();
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? PRESETS[0].baseURL);
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
  const [model, setModel] = useState(existing?.model ?? PRESETS[0].model);

  if (!open) return null;

  const save = () => {
    if (!apiKey.trim()) return;
    const cfg: ByoKeyConfig = {
      baseURL: baseURL.trim().replace(/\/$/, ""),
      apiKey: apiKey.trim(),
      model: model.trim(),
    };
    localStorage.setItem(BYO_STORAGE_KEY, JSON.stringify(cfg));
    onSave(cfg);
  };

  const clear = () => {
    localStorage.removeItem(BYO_STORAGE_KEY);
    onSave(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold">{t("title")}</h3>
        {reason && (
          <p className="mt-1 text-sm text-amber-400/90">{reason}</p>
        )}
        <p className="mt-2 text-xs text-zinc-400">
          {t.rich("compatNote", { b: (c) => <span className="text-zinc-300">{c}</span> })}
        </p>
        <p className="mt-1.5 text-xs text-amber-400/90">
          {t.rich("tempKeyNote", { b: (c) => <span className="font-semibold">{c}</span> })}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setBaseURL(p.baseURL);
                setModel(p.model);
              }}
              className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/10"
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-xs text-zinc-400">{t("baseUrl")}</label>
        <input
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-500/60"
          placeholder="https://api.openai.com/v1"
        />
        <label className="mt-3 block text-xs text-zinc-400">{t("apiKey")}</label>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-500/60"
          placeholder="sk-..."
        />
        <label className="mt-3 block text-xs text-zinc-400">{t("model")}</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-500/60"
          placeholder="gpt-4o-mini"
        />

        <div className="mt-5 flex items-center justify-between">
          <button onClick={clear} className="text-xs text-zinc-500 hover:text-zinc-300">
            {t("clear")}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:bg-white/5"
            >
              {t("cancel")}
            </button>
            <button
              onClick={save}
              disabled={!apiKey.trim()}
              className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-40"
            >
              {t("saveContinue")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
