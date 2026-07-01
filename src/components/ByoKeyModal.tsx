"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

function getInitialConfig(): ByoKeyConfig {
  const existing = loadByoKey();
  return {
    baseURL: existing?.baseURL ?? PRESETS[0].baseURL,
    apiKey: existing?.apiKey ?? "",
    model: existing?.model ?? PRESETS[0].model,
  };
}

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
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {open ? (
        <ByoKeyModalContent reason={reason} onClose={onClose} onSave={onSave} />
      ) : null}
    </Dialog>
  );
}

function ByoKeyModalContent({
  reason,
  onClose,
  onSave,
}: {
  reason?: string;
  onClose: () => void;
  onSave: (cfg: ByoKeyConfig | null) => void;
}) {
  const t = useTranslations("byok");
  const initial = getInitialConfig();
  const [baseURL, setBaseURL] = useState(initial.baseURL);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [model, setModel] = useState(initial.model);

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
    setBaseURL(PRESETS[0].baseURL);
    setApiKey("");
    setModel(PRESETS[0].model);
  };

  return (
    <DialogContent
      className="w-full max-w-[30.5rem] border border-white/10 bg-zinc-900 p-6 shadow-2xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
    >
      <DialogHeader className="space-y-0">
        <DialogTitle>{t("title")}</DialogTitle>
      </DialogHeader>
      {reason && (
        <p className="mt-1 text-sm text-amber-400/90">{reason}</p>
      )}
      <DialogDescription className="mt-2 text-xs text-zinc-400">
        {t.rich("compatNote", { b: (c) => <span className="text-zinc-300">{c}</span> })}
      </DialogDescription>
      <p className="mt-1.5 text-xs text-amber-400/90">
        {t.rich("tempKeyNote", { b: (c) => <span className="font-semibold">{c}</span> })}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            type="button"
            onClick={() => {
              setBaseURL(p.baseURL);
              setModel(p.model);
            }}
            variant="outline"
            size="sm"
            shape="pill"
            className="h-auto border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/10"
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="mt-4 space-y-1">
        <Label htmlFor="byo-base-url">{t("baseUrl")}</Label>
        <Input
          id="byo-base-url"
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          className="border-white/15 bg-white/5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-orange-400/60 focus-visible:ring-orange-500/20"
          placeholder="https://api.openai.com/v1"
        />
      </div>
      <div className="mt-3 space-y-1">
        <Label htmlFor="byo-api-key">{t("apiKey")}</Label>
        <Input
          id="byo-api-key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
          className="border-white/15 bg-white/5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-orange-400/60 focus-visible:ring-orange-500/20"
          placeholder="sk-..."
        />
      </div>
      <div className="mt-3 space-y-1">
        <Label htmlFor="byo-model">{t("model")}</Label>
        <Input
          id="byo-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="border-white/15 bg-white/5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-orange-400/60 focus-visible:ring-orange-500/20"
          placeholder="gpt-4o-mini"
        />
      </div>

      <DialogFooter className="mt-5 flex-row items-center justify-between sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto px-0 text-xs text-zinc-500 hover:bg-transparent hover:text-zinc-300"
          onClick={clear}
        >
          {t("clear")}
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            className="text-zinc-400 hover:bg-white/5"
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={!apiKey.trim()}
            className="bg-orange-600 text-white hover:bg-orange-500"
          >
            {t("saveContinue")}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
