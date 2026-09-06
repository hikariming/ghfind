"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Upload, X } from "lucide-react";
import type { Resume } from "@/lib/resume";

export async function prepareResumePhoto(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("format");
  if (file.size > 5 * 1024 * 1024) throw new Error("size");
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error("dimensions");
    const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/jpeg", .84);
    if (result.length > 700000) throw new Error("size");
    return result;
  } finally { bitmap.close(); }
}

export function ResumePhotoInput({ zh, photo, onChange }: { zh: boolean; photo: Resume["photo"]; onChange: (photo: Resume["photo"]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => () => { ++request.current; }, []);
  const copy = (cn: string, en: string) => zh ? cn : en;
  return <div className="resume-photo-editor">
    <div className="resume-photo-upload-row">
      <div className="resume-photo-thumbnail">{photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- browser-local data URL
        <img src={photo.data} alt={copy("个人照片", "Portrait")} style={{ objectPosition: `center ${photo.position}%` }} />
      ) : <Camera size={23} aria-hidden />}</div>
      <div><h3>{copy("个人照片", "Portrait")} <span>{copy("选填", "Optional")}</span></h3>
        <label className={`resume-button resume-photo-upload ${busy ? "is-busy" : ""}`}><Upload size={13} />{busy ? copy("正在处理…", "Processing…") : photo ? copy("替换照片", "Replace photo") : copy("上传照片", "Upload photo")}
          <input type="file" accept="image/jpeg,image/png,image/webp" aria-label={copy("上传个人照片", "Upload portrait")} disabled={busy} onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            const token = ++request.current;
            setBusy(true); setError("");
            try {
              const data = await prepareResumePhoto(file);
              if (token === request.current) onChange({ data, position: 35 });
            } catch {
              if (token === request.current) setError(copy("无法读取照片。请选择 5 MB 以内的 JPG、PNG 或 WebP 图片（不超过 4000 万像素）。原照片已保留。", "Could not read this photo. Choose JPG, PNG or WebP up to 5 MB and 40 megapixels. Your previous photo is unchanged."));
            } finally { if (token === request.current) setBusy(false); }
          }} />
        </label>
        {photo && <button type="button" className="resume-text-button" disabled={busy} onClick={() => { ++request.current; onChange(undefined); setError(""); }}><X size={13} />{copy("移除", "Remove")}</button>}
      </div>
    </div>
    <p>{copy("支持 JPG、PNG、WebP，最大 5 MB。图片会在浏览器内压缩，随简历保存到本地，不会上传到服务器。上传后请保存简历。", "JPG, PNG or WebP, up to 5 MB. Photos are compressed in your browser and saved locally with your résumé, never uploaded to a server. Save your résumé after adding a photo.")}</p>
    {photo && <label className="resume-photo-position">{copy("照片取景 · 上下位置", "Crop · vertical position")}<input type="range" min="0" max="100" value={photo.position} onChange={event => onChange({ ...photo, position: Number(event.target.value) })} /></label>}
    {error && <p role="alert" className="resume-error">{error}</p>}
  </div>;
}
