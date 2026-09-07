"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Camera, Check, Crop, Upload, X, ZoomIn } from "lucide-react";
import type { Resume } from "@/lib/resume";

// Matches the portrait boxes across templates (6em×7em, noir aspect-ratio .85).
export const RESUME_PHOTO_CROP_ASPECT = 6 / 7;
const RESUME_PHOTO_MAX_EDGE = 600;

export async function decodeResumePhoto(file: File): Promise<ImageBitmap> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("format");
  if (file.size > 5 * 1024 * 1024) throw new Error("size");
  const bitmap = await createImageBitmap(file);
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) { bitmap.close(); throw new Error("dimensions"); }
  return bitmap;
}

export function renderCroppedResumePhoto(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): string {
  const height = Math.min(RESUME_PHOTO_MAX_EDGE, Math.max(1, Math.round(sh)));
  const canvas = document.createElement("canvas");
  canvas.height = height;
  canvas.width = Math.max(1, Math.round(height * (sw / sh)));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL("image/jpeg", .84);
  if (result.length > 700000) throw new Error("size");
  return result;
}

function PhotoCropDialog({ zh, source, onCancel, onConfirm }: { zh: boolean; source: string; onCancel: () => void; onConfirm: (data: string) => void }) {
  const copy = (cn: string, en: string) => zh ? cn : en;
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ pointer: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onCancel]);

  const cropHeight = Math.min(viewport.height, viewport.width / RESUME_PHOTO_CROP_ASPECT) * .66;
  const cropWidth = cropHeight * RESUME_PHOTO_CROP_ASPECT;
  const ready = natural.width > 0 && cropWidth > 0;
  const base = ready ? Math.max(cropWidth / natural.width, cropHeight / natural.height) : 1;
  const scale = base * zoom;
  const shownWidth = natural.width * scale;
  const shownHeight = natural.height * scale;
  const clamp = (point: { x: number; y: number }) => ({
    x: Math.min(Math.max(0, (shownWidth - cropWidth) / 2), Math.max(-Math.max(0, (shownWidth - cropWidth) / 2), point.x)),
    y: Math.min(Math.max(0, (shownHeight - cropHeight) / 2), Math.max(-Math.max(0, (shownHeight - cropHeight) / 2), point.y)),
  });
  const position = clamp(offset);

  function confirm() {
    const image = imageRef.current;
    if (!image || !ready) return;
    const sx = Math.max(0, Math.min(natural.width - cropWidth / scale, ((shownWidth - cropWidth) / 2 - position.x) / scale));
    const sy = Math.max(0, Math.min(natural.height - cropHeight / scale, ((shownHeight - cropHeight) / 2 - position.y) / scale));
    try {
      onConfirm(renderCroppedResumePhoto(image, sx, sy, Math.min(cropWidth / scale, natural.width - sx), Math.min(cropHeight / scale, natural.height - sy)));
    } catch {
      setError(copy("无法生成裁剪后的照片，请换一张图片重试。", "Could not crop this photo. Try another image."));
    }
  }

  return <div className="resume-crop-overlay" role="presentation">
    <div className="resume-crop-dialog" role="dialog" aria-modal="true" aria-label={copy("裁剪照片", "Crop photo")}>
      <div className="resume-crop-heading"><h3>{copy("裁剪照片", "Crop photo")}</h3><p>{copy("拖动调整位置，用滑块缩放。框内区域将作为简历照片。", "Drag to position, zoom with the slider. The framed area becomes your portrait.")}</p></div>
      <div className="resume-crop-viewport" ref={viewportRef}
        onPointerDown={event => { if (!ready) return; viewportRef.current?.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, baseX: position.x, baseY: position.y }; }}
        onPointerMove={event => { if (drag.current?.pointer !== event.pointerId) return; setOffset({ x: drag.current.baseX + event.clientX - drag.current.startX, y: drag.current.baseY + event.clientY - drag.current.startY }); }}
        onPointerUp={event => { if (drag.current?.pointer === event.pointerId) drag.current = null; }}
        onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) drag.current = null; }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- browser-local crop preview */}
        <img ref={imageRef} src={source} alt="" draggable={false} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={ready ? { width: shownWidth, height: shownHeight, transform: `translate(${position.x - shownWidth / 2}px, ${position.y - shownHeight / 2}px)` } : { opacity: 0 }} />
        {ready && <div className="resume-crop-frame" style={{ width: cropWidth, height: cropHeight }} aria-hidden />}
      </div>
      <label className="resume-crop-zoom"><ZoomIn size={15} aria-hidden /><span className="sr-only">{copy("缩放", "Zoom")}</span>
        <input type="range" min="1" max="3" step=".01" value={zoom} aria-label={copy("缩放", "Zoom")} onChange={event => setZoom(Number(event.target.value))} />
        <span>{Math.round(zoom * 100)}%</span>
      </label>
      {error && <p role="alert" className="resume-error">{error}</p>}
      <div className="resume-crop-actions">
        <button type="button" className="resume-button" onClick={onCancel}><X size={14} />{copy("取消", "Cancel")}</button>
        <button type="button" className="resume-button resume-button-primary" disabled={!ready} onClick={confirm}><Check size={14} />{copy("确认裁剪", "Apply crop")}</button>
      </div>
    </div>
  </div>;
}

export function ResumePhotoInput({ zh, photo, onChange }: { zh: boolean; photo: Resume["photo"]; onChange: (photo: Resume["photo"]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cropSource, setCropSource] = useState<string | null>(null);
  const cropObjectUrl = useRef<string | null>(null);
  const request = useRef(0);
  const copy = (cn: string, en: string) => zh ? cn : en;

  function closeCrop() {
    ++request.current;
    if (cropObjectUrl.current) { URL.revokeObjectURL(cropObjectUrl.current); cropObjectUrl.current = null; }
    setCropSource(null);
  }
  useEffect(() => () => { ++request.current; if (cropObjectUrl.current) URL.revokeObjectURL(cropObjectUrl.current); }, []);

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
              (await decodeResumePhoto(file)).close();
              if (token !== request.current) return;
              const url = URL.createObjectURL(file);
              if (cropObjectUrl.current) URL.revokeObjectURL(cropObjectUrl.current);
              cropObjectUrl.current = url;
              setCropSource(url);
            } catch {
              if (token === request.current) setError(copy("无法读取照片。请选择 5 MB 以内的 JPG、PNG 或 WebP 图片（不超过 4000 万像素）。原照片已保留。", "Could not read this photo. Choose JPG, PNG or WebP up to 5 MB and 40 megapixels. Your previous photo is unchanged."));
            } finally { if (token === request.current) setBusy(false); }
          }} />
        </label>
        {photo && <button type="button" className="resume-text-button" disabled={busy} onClick={() => setCropSource(photo.data)}><Crop size={13} />{copy("重新裁剪", "Re-crop")}</button>}
        {photo && <button type="button" className="resume-text-button" disabled={busy} onClick={() => { ++request.current; onChange(undefined); setError(""); }}><X size={13} />{copy("移除", "Remove")}</button>}
      </div>
    </div>
    <p>{copy("支持 JPG、PNG、WebP，最大 5 MB。上传后在浏览器内裁剪并压缩。点击保存后，随简历保存到本地；登录后也会保存到云端。", "JPG, PNG or WebP, up to 5 MB. Photos are cropped and compressed in your browser. Save your résumé to keep the photo locally and, when signed in, in the cloud.")}</p>
    {error && <p role="alert" className="resume-error">{error}</p>}
    {cropSource && <PhotoCropDialog zh={zh} source={cropSource} onCancel={closeCrop} onConfirm={data => { onChange({ data, position: 50 }); setError(""); closeCrop(); }} />}
  </div>;
}
