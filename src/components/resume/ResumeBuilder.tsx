"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Cloud, Printer, RefreshCw, FileText, HardDrive, LayoutTemplate, Plus, Save, Sparkles, Trash2, Undo2 } from "lucide-react";
import { createResume, emptyEntry, newSection, readResumeLibrary, resumeStorageSnapshot, sameResumeContent, RESUME_STORAGE_KEY, sampleResume, SECTION_TYPES, sectionNames, serializeResumeLibrary, TEMPLATE_IDS, upsertResume, type Resume, type ResumeSection, type TemplateId } from "@/lib/resume";
import { fetchMe, type Me } from "@/lib/me-client";
import { signInWithGitHub } from "@/lib/oauth-client";
import { ResumePhotoInput } from "./ResumePhotoInput";
import { ResumePagedPaper } from "./ResumePagedPaper";
import { ResumePaper } from "./ResumePaper";

const templateCopy = {
  zh: { noir: ["黑白肖像", "大标题与黑白双栏，教育和技能独立呈现。"], editorial: ["清爽双栏", "克制的层次与留白，适合产品与技术岗位。"], modern: ["现代蓝调", "鲜明的个人标识，让经历更容易被看见。"], classic: ["经典排版", "简洁、正式，让内容成为第一主角。"] },
  en: { noir: ["Monochrome", "Bold typography, a portrait and a dedicated credentials column."], editorial: ["Editorial", "Clear hierarchy for product and engineering roles."], modern: ["Modern", "A distinctive identity and a confident blue accent."], classic: ["Classic", "Quiet, considered typography that puts content first."] },
};

function nextSavedAt(previous?: string) {
  return new Date(Math.max(Date.now(), (Date.parse(previous ?? "") || 0) + 1)).toISOString();
}

export function ResumeBuilder({ zh }: { zh: boolean }) {
  const copy = (cn: string, en: string) => zh ? cn : en;
  const templates = templateCopy[zh ? "zh" : "en"];
  const [ready, setReady] = useState(false);
  const [library, setLibrary] = useState<Resume[]>([]);
  const [draft, setDraft] = useState<Resume | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [view, setView] = useState<"gallery" | "editor">("gallery");
  const [tab, setTab] = useState<"basics" | "sections" | "templates">("basics");
  const [mobilePanel, setMobilePanel] = useState<"edit" | "preview">("edit");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<Resume | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [cloudLibrary, setCloudLibrary] = useState<Resume[]>([]);
  const [cloudState, setCloudState] = useState<"loading" | "ready" | "error" | "signed-out">("loading");
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);
  const localBase = useRef<{ id: string; snapshot: string; preserve: boolean } | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const dirty = draft !== null && JSON.stringify(draft) !== savedSnapshot;

  useEffect(() => { window.scrollTo({ top: 0, behavior: "instant" }); }, [view]);

  useEffect(() => {
    let live = true;
    // Read after hydration so no browser-only data enters the static page shell.
    Promise.resolve().then(() => {
      if (!live) return;
      try { setLibrary(readResumeLibrary(localStorage.getItem(RESUME_STORAGE_KEY))); }
      catch { setError(zh ? "无法读取本地简历。原有数据未被修改，请检查浏览器存储权限或数据格式。" : "Unable to read local résumés. Existing data has not been changed. Check browser storage permissions or the data format."); }
      setReady(true);
    });
    return () => { live = false; };
  }, [zh]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardNavigation = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || anchor.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm(zh ? "简历有未保存的修改，确定离开吗？" : "Your résumé has unsaved changes. Leave this page?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardNavigation, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", guardNavigation, true); };
  }, [dirty, zh]);

  function canReplace() { return !dirty || window.confirm(copy("当前修改尚未保存，确定切换到另一份简历吗？", "Discard unsaved changes and open another résumé?")); }
  function begin(template: TemplateId) {
    if (!canReplace()) return;
    localBase.current = null;
    setDraft(createResume(template, zh)); setSavedSnapshot(""); setView("editor"); setTab("basics"); setUndo(null); setNotice(""); setError(""); setConflict(false);
  }
  function openResume(resume: Resume, fromCloud = false) {
    if (!canReplace()) return;
    try {
      const local = readResumeLibrary(localStorage.getItem(RESUME_STORAGE_KEY)).find(item => item.id === resume.id);
      localBase.current = { id: resume.id, snapshot: resumeStorageSnapshot(local), preserve: !!(fromCloud && local && !sameResumeContent(local, resume)) };
    } catch { setError(copy("无法读取本地备份，请检查浏览器存储后重试。", "Cannot read the local backup. Check browser storage and retry.")); return; }
    setDraft(resume); setSavedSnapshot(JSON.stringify(resume)); setView("editor"); setTab("basics"); setUndo(null); setNotice(""); setError(""); setConflict(false);
  }
  function saveLocal(value: Resume): Resume {
    const latest = readResumeLibrary(localStorage.getItem(RESUME_STORAGE_KEY));
    const previous = latest.find(item => item.id === value.id);
    const base = localBase.current?.id === value.id ? localBase.current : null;
    if (base ? resumeStorageSnapshot(previous) !== base.snapshot : !!previous && previous.updatedAt !== value.updatedAt) {
      throw new Error("local_conflict");
    }
    const saved = { ...value, name: value.name.trim() || copy("未命名简历", "Untitled résumé"), updatedAt: nextSavedAt(previous?.updatedAt) };
    // Editing a cloud version keeps any different local version as a separate
    // backup. Reading a cloud document never discards local-only changes.
    const preserved = base?.preserve && previous ? upsertResume(latest, { ...previous, id: crypto.randomUUID(), name: `${previous.name} (${copy("本地备份", "local backup")})`, cloudBase: undefined }) : latest;
    const next = upsertResume(preserved, saved);
    localStorage.setItem(RESUME_STORAGE_KEY, serializeResumeLibrary(next));
    localBase.current = { id: saved.id, snapshot: resumeStorageSnapshot(saved), preserve: false };
    setLibrary(next); setDraft(saved); setSavedSnapshot(JSON.stringify(saved));
    return saved;
  }
  async function save(asCopy = false) {
    if (!draft || saving.current) return;
    saving.current = true; setSyncBusy(true); setError(""); setNotice(""); setConflict(false);
    const account = me?.user?.login;
    const remote = cloudLibrary.find(item => item.id === draft.id);
    const baseUpdatedAt = draft.cloudBase && draft.cloudBase.account === account ? draft.cloudBase.updatedAt : remote ? draft.updatedAt : null;
    const value = asCopy ? { ...draft, id: crypto.randomUUID(), name: `${draft.name} (${copy("副本", "copy")})`, updatedAt: "", cloudBase: undefined } : draft;
    let local: Resume;
    try {
      local = saveLocal({ ...value, cloudBase: account ? { account, updatedAt: asCopy ? null : baseUpdatedAt } : value.cloudBase });
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "local_conflict"
        ? copy("此浏览器已有另一版本。请另存副本，保留两份内容。", "This browser has another version. Save a copy to keep both." )
        : copy("无法保存到此浏览器，可能空间已满。请复制内容备份后重试。", "Browser storage is unavailable or full. Back up your edits and retry."));
      setConflict(true); saving.current = false; setSyncBusy(false); return;
    }
    if (!account) {
      setNotice(copy("已保存到此浏览器", "Saved in this browser"));
      saving.current = false; setSyncBusy(false); return;
    }
    try {
      const res = await fetch("/api/resumes", { signal: AbortSignal.timeout(20000), method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resume: local, baseUpdatedAt: asCopy ? null : baseUpdatedAt }) });
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 409) { setConflict(true); throw new Error(copy("云端已有新版本。你的修改已留在本地，可以另存副本，或返回列表打开云端版本。", "The cloud has a newer version. Your edits are safe locally. Save a copy or open the cloud version from the library.")); }
        if (res.status === 401) { setCloudState("signed-out"); throw new Error(copy("登录已过期。本地已保存，请重新登录后再保存到云端。", "Your session expired. Saved locally; sign in again to save to the cloud.")); }
        throw new Error(res.status === 413 ? copy("本地已保存，云端容量不足。请缩减照片或内容后重试。", "Saved locally. Cloud storage is full; reduce photos or content and retry.") : copy("本地已保存，云端暂时不可用。请稍后点击保存重试。", "Saved locally. Cloud unavailable; click Save to retry."));
      }
      const cloud = readResumeLibrary(JSON.stringify({ version: 1, resumes: [body.resume] }))[0];
      setCloudLibrary(items => upsertResume(items, cloud));
      const saved = { ...cloud, cloudBase: { account, updatedAt: cloud.updatedAt } };
      // The editor is disabled during saving; another browser tab can still write.
      const latest = readResumeLibrary(localStorage.getItem(RESUME_STORAGE_KEY));
      if (latest.find(item => item.id === local.id)?.updatedAt !== local.updatedAt) {
        setNotice(copy("已保存到云端；另一标签页的本地版本已保留。", "Saved to cloud; the other tab's local version was preserved."));
        return;
      }
      const next = upsertResume(latest, saved);
      localStorage.setItem(RESUME_STORAGE_KEY, serializeResumeLibrary(next));
      localBase.current = { id: saved.id, snapshot: resumeStorageSnapshot(saved), preserve: false };
      setLibrary(next); setDraft(saved); setSavedSnapshot(JSON.stringify(saved));
      setNotice(copy("已保存到云端，并保留本地备份", "Saved to cloud with a local backup"));
    } catch (cause) { setError(cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof SyntaxError) && !(cause instanceof DOMException) ? cause.message : copy("本地已保存，网络连接异常，请点击保存重试。", "Saved locally. Connection failed; click Save to retry.")); }
    finally { saving.current = false; setSyncBusy(false); }
  }
  function updateSection(id: string, update: (section: ResumeSection) => ResumeSection) {
    setDraft(current => current && ({ ...current, sections: current.sections.map(section => section.id === id ? update(section) : section) })); setNotice("");
  }
  function moveSection(index: number, delta: number) {
    if (!draft) return;
    const sections = [...draft.sections];
    [sections[index], sections[index + delta]] = [sections[index + delta], sections[index]];
    setDraft({ ...draft, sections });
  }
  function selectTemplate(template: TemplateId) { setDraft(current => current && ({ ...current, template })); setNotice(""); }

  async function refreshCloud() {
    setCloudState("loading");
    try {
      const res = await fetch("/api/resumes", { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (res.status === 401) { setCloudState("signed-out"); return; }
      if (!res.ok) throw new Error("load_failed");
      const body = await res.json();
      if (!(body.data === null || typeof body.data === "string")) throw new Error("invalid_library");
      setCloudLibrary(readResumeLibrary(body.data)); setCloudState("ready");
    } catch { setCloudState("error"); }
  }
  useEffect(() => {
    let live = true;
    fetchMe().then(async session => {
      if (!live) return;
      setMe(session);
      if (!session.user) { setCloudState("signed-out"); return; }
      try {
        const res = await fetch("/api/resumes", { cache: "no-store", signal: AbortSignal.timeout(20000) });
        if (!live) return;
        if (res.status === 401) { setCloudState("signed-out"); return; }
        if (!res.ok) throw new Error("load_failed");
        const body = await res.json();
        if (!(body.data === null || typeof body.data === "string")) throw new Error("invalid_library");
        if (live) { setCloudLibrary(readResumeLibrary(body.data)); setCloudState("ready"); }
      } catch { if (live) setCloudState("error"); }
    });
    return () => { live = false; };
  }, []);

  // Preview the current template with illustrative content. Keeps the document
  // name/template, offers the existing undo path, and never touches saved data
  // until the user saves.
  function fillSample() {
    if (!draft) return;
    if (!window.confirm(copy("将用示例数据覆盖当前简历的内容（保留名称和模板，可在内容区块页撤销），确定吗？", "Replace this résumé's content with sample data? The name and template stay, and you can undo it from the Sections tab."))) return;
    const sample = sampleResume(draft.template, zh);
    setUndo(draft);
    setDraft({ ...draft, basics: sample.basics, sections: sample.sections });
    setNotice(copy("已填入示例数据，看看整体效果；保存前不会覆盖已存内容", "Sample data filled in — nothing is overwritten until you save"));
  }

  const cloudMatch = draft && cloudLibrary.find(item => item.id === draft.id);
  const savedToCloud = !!(draft && cloudMatch && sameResumeContent(draft, cloudMatch));
  const saveStatus = syncBusy ? copy("正在保存…", "Saving…") : dirty ? copy("有未保存的修改", "Unsaved changes") : savedToCloud ? copy("已保存到云端", "Saved to cloud") : copy("已保存到此浏览器", "Saved in this browser");
  const localNotice = <div className="resume-local-note"><HardDrive size={17} aria-hidden /><p>{me?.user
    ? copy("点击保存，同时保存当前简历到云端和此浏览器。云端简历会自动显示在列表中。", "Save keeps this résumé in the cloud and in this browser. Cloud résumés appear in your library automatically.")
    : me?.oauth === false ? copy("简历保存在此浏览器，清除浏览器数据会丢失。此环境暂未开启云端登录。", "Résumés are saved in this browser; clearing browser data removes them. Cloud sign-in is unavailable in this environment.") : copy("无需登录即可制作简历，保存后仅在此浏览器可见。登录后可保存到云端，换设备继续编辑。", "Create without signing in and save in this browser. Sign in to save to the cloud and continue on another device.")}</p></div>;
  const localOnly = library.filter(item => !cloudLibrary.some(remote => remote.id === item.id && sameResumeContent(item, remote)));
  function renderResume(resume: Resume, cloud: boolean) {
    return <button key={resume.id} className="resume-saved-item" onClick={() => openResume(resume, cloud)}>{cloud ? <Cloud size={21} /> : <FileText size={21} />}<span><strong>{resume.name}</strong><small>{templates[resume.template][0]} · {new Date(resume.updatedAt).toLocaleString(zh ? "zh-CN" : "en-GB")}</small></span><ArrowRight size={16} /></button>;
  }

  return <main className={`resume-app ${view === "editor" ? "resume-is-editing" : ""}`}>
    <header className="resume-page-heading">
      <div><div className="resume-eyebrow">G H F I N D / CAREER</div><h1>{copy("我的简历", "My résumés")} <span className="resume-beta">{copy("预览版", "Preview")}</span></h1><p>{copy("把你的经历，整理成下一次机会。", "Make room for your next opportunity.")}</p></div>
      {view === "editor" && <div className="resume-header-actions"><button className="resume-button" disabled={syncBusy} onClick={() => setView("gallery")}><ArrowLeft size={15} />{copy("模板与简历", "Templates & résumés")}</button><button className="resume-button" disabled={syncBusy} onClick={() => window.print()}><Printer size={15} />{copy("导出 PDF", "Export PDF")}</button><button className="resume-button resume-button-primary" disabled={syncBusy || !me || (!!me.user && cloudState === "loading")} onClick={() => void save()}><Save size={15} />{syncBusy ? copy("保存中…", "Saving…") : me?.user ? copy("保存到云端", "Save to cloud") : copy("保存简历", "Save résumé")}</button></div>}
    </header>
    {localNotice}
    {error && <div className="resume-error" role="alert">{error}{cloudState === "signed-out" && me?.user && <button className="resume-button" onClick={() => signInWithGitHub()}>{copy("重新登录", "Sign in again")}</button>}{conflict && draft && <button className="resume-button" disabled={syncBusy} onClick={() => void save(true)}>{copy("另存为副本", "Save a copy")}</button>}</div>}
    {notice && <p className="resume-feedback" role="status">{notice}</p>}
    {!ready ? <p className="resume-loading">{copy("正在读取本地简历…", "Reading local résumés…")}</p> : view === "gallery" ? <>
      <section className="resume-cloud" aria-label={copy("保存与同步", "Storage & sync")}>
        <div className="resume-cloud-info"><h2>{me?.user ? copy(`@${me.user.login} 的简历`, `@${me.user.login}'s résumés`) : copy("在不同设备上继续编辑", "Continue on any device")}</h2><p>{cloudState === "loading" ? copy("正在读取云端简历…", "Loading cloud résumés…") : cloudState === "error" ? copy("暂时无法读取云端，本地简历仍可编辑。", "Cloud unavailable. Your local résumés are still here.") : cloudState === "signed-out" ? me?.oauth === false ? copy("此环境暂未开启登录，请先保存到此浏览器。", "Sign-in is unavailable here. Save in this browser for now.") : copy("登录 GitHub，将需要的简历保存到你的账号。", "Sign in with GitHub to save résumés to your account.") : cloudLibrary.length === 0 && localOnly.length === 0 ? copy("你还没有简历，请在下方新建简历。", "You don't have any résumés yet — create one below.") : copy("云端内容已读取。点击简历即可编辑，无需手动加载或覆盖本地库。", "Cloud library loaded. Open a résumé to edit; local drafts stay untouched.")}</p></div>
        <div className="resume-cloud-actions">{me?.user && cloudState !== "signed-out" ? <button className="resume-button" disabled={cloudState === "loading"} onClick={() => void refreshCloud()}><RefreshCw size={15} />{copy("刷新列表", "Refresh")}</button> : me?.oauth !== false && <button className="resume-button" disabled={!me} onClick={() => signInWithGitHub()}>{copy("用 GitHub 登录", "Sign in with GitHub")}</button>}{draft && <button className="resume-button" onClick={() => setView("editor")}>{copy("继续编辑", "Continue editing")}<ArrowRight size={14} /></button>}</div>
      </section>
      {cloudLibrary.length > 0 && <section className="resume-library"><div className="resume-section-heading"><h2>{copy("云端简历", "Cloud résumés")} <span className="resume-section-count">{cloudLibrary.length}</span></h2></div><div className="resume-saved-list">{cloudLibrary.map(item => renderResume(item, true))}</div></section>}
      {cloudState === "ready" && cloudLibrary.length === 0 && localOnly.length > 0 && <p className="resume-empty">{copy("还没有云端简历。打开本地简历或选择模板，编辑后点击「保存到云端」。", "No cloud résumés yet. Open a local draft or choose a template, then save to the cloud.")}</p>}
      {localOnly.length > 0 && <section className="resume-library"><div className="resume-section-heading"><div><h2>{copy("此浏览器中的草稿", "Drafts in this browser")}</h2><p>{copy("尚未保存到云端，或与云端内容不同。打开后可继续编辑和保存。", "Local-only drafts or versions that differ from the cloud. Open to edit and save.")}</p></div></div><div className="resume-saved-list">{localOnly.map(item => renderResume(item, false))}</div></section>}
      <section className="resume-template-gallery"><div className="resume-section-heading"><div><h2>{copy("从一个好看的模板开始", "Start with a considered template")}</h2><p>{copy("四种风格，同一份内容。进入编辑器后也可以随时更换。下方为示例排版。", "Four styles, the same story. Switch templates any time. Thumbnails show sample content.")}</p></div><span className="resume-section-count">01 — 04</span></div>
        <div className="resume-template-grid">{TEMPLATE_IDS.map((template, index) => <button key={template} className="resume-template-card" onClick={() => begin(template)}><div className="resume-template-thumbnail"><ResumePaper resume={sampleResume(template, zh)} zh={zh} miniature /></div><div className="resume-template-caption"><span className="resume-template-index">0{index + 1}</span><div><h3>{templates[template][0]}</h3><p>{templates[template][1]}</p></div><ArrowRight size={18} /></div><span className="resume-template-use">{copy("使用此模板", "Use template")} <ArrowRight size={14} /></span></button>)}</div>
      </section>
    </> : draft && <>
      <fieldset className="resume-editing-fields" disabled={syncBusy}><div className="resume-document-bar"><label>{copy("简历名称", "Document name")}<input value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><span className="resume-document-tools"><button className="resume-text-button" onClick={fillSample}><Sparkles size={14} />{copy("填入示例数据", "Fill sample data")}</button><span role="status" className="resume-save-status">{saveStatus}{!dirty && <Check size={14} />}</span></span></div>
      <div className="resume-mobile-switch"><button aria-pressed={mobilePanel === "edit"} onClick={() => setMobilePanel("edit")}>{copy("编辑内容", "Edit")}</button><button aria-pressed={mobilePanel === "preview"} onClick={() => setMobilePanel("preview")}>{copy("简历预览", "Preview")}</button></div>
      <div className="resume-studio" data-mobile-panel={mobilePanel}>
        <section className="resume-preview-pane"><div className="resume-pane-heading"><span>{copy("实时预览", "Live preview")}</span><span>{templates[draft.template][0]}</span></div><div className="resume-paper-stage"><ResumePagedPaper resume={draft} zh={zh} /></div><p className="resume-preview-caption">{copy("预览会随输入更新 · A4 幅面，内容较长时自动分页", "Preview updates as you type · A4 pages, overflow continues on the next page")}</p></section>
        <section className="resume-editor-pane" aria-label={copy("简历编辑器", "Résumé editor")}>
          <div className="resume-editor-tabs" role="tablist" aria-label={copy("编辑分类", "Editor sections")}>
            {(["basics", "sections", "templates"] as const).map((key, index) => <button key={key} id={`resume-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`resume-panel-${key}`} tabIndex={tab === key ? 0 : -1} onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const keys = ["basics", "sections", "templates"] as const;
              const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : -1) + 3) % 3;
              setTab(keys[next]);
              (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
            }} onClick={() => setTab(key)}>{[copy("基本信息", "Basics"), copy("内容区块", "Sections"), copy("模板", "Templates")][index]}</button>)}
          </div>
          <div className="resume-editor-content" role="tabpanel" id={`resume-panel-${tab}`} aria-labelledby={`resume-tab-${tab}`}>
            {tab === "basics" && <><h2>{copy("基本信息", "Personal details")}</h2><p className="resume-editor-hint">{copy("填写你希望展示的信息，留空的字段不会显示。", "Only the fields you fill in will appear.")}</p>
              <ResumePhotoInput zh={zh} photo={draft.photo} onChange={photo => { setDraft(current => current && ({ ...current, photo })); setNotice(""); }} />
              <div className="resume-fields">{(["name", "role", "email", "phone", "city", "website"] as const).map((key, index) => <label key={key}>{[copy("姓名", "Name"), copy("求职方向 / 职位", "Role / career focus"), copy("邮箱", "Email"), copy("电话", "Phone"), copy("所在城市", "Location"), copy("个人网站 / GitHub", "Website / GitHub")][index]}<input type={key === "email" ? "email" : "text"} autoComplete="off" value={draft.basics[key]} maxLength={500} placeholder={[copy("你的姓名", "Your name"), copy("例如：前端工程师", "e.g. Frontend Engineer"), "hello@example.com", copy("选填", "Optional"), copy("例如：上海", "e.g. London"), "github.com/username"][index]} onChange={event => { setDraft({ ...draft, basics: { ...draft.basics, [key]: event.target.value } }); setNotice(""); }} /></label>)}</div>
              <label className="resume-field">{copy("个人简介", "Summary")}<textarea rows={5} maxLength={20000} value={draft.basics.summary} placeholder={copy("用两三句话介绍你的方向、擅长的领域和代表性成果。", "Introduce your focus, strengths and a meaningful achievement.")} onChange={event => setDraft({ ...draft, basics: { ...draft.basics, summary: event.target.value } })} /></label>
              <button className="resume-button resume-next" onClick={() => setTab("sections")}>{copy("接下来，补充经历", "Next, add your experience")}<ArrowRight size={15} /></button>
            </>}
            {tab === "sections" && <><div className="resume-section-heading"><h2>{copy("经历与技能", "Experience & skills")}</h2>{undo && <button className="resume-text-button" onClick={() => { setDraft({ ...undo, updatedAt: draft.updatedAt }); setUndo(null); }}><Undo2 size={14} />{copy("撤销删除", "Undo delete")}</button>}</div><p className="resume-editor-hint">{copy("展开区块编辑；用箭头调整顺序。每个区块可添加多条经历。", "Expand a section to edit it. Reorder with arrows and add multiple entries.")}</p>
              {draft.sections.map((section, index) => <details className="resume-section-editor" key={section.id}>
                <summary><span>{String(index + 1).padStart(2, "0")}</span>{section.title || copy("未命名区块", "Untitled section")}<Plus size={14} /></summary>
                <div className="resume-section-body"><div className="resume-block-tools"><button className="shell-icon" disabled={index === 0} onClick={() => moveSection(index, -1)} aria-label={copy(`上移${section.title}`, `Move ${section.title} up`)}><ArrowUp size={15} /></button><button className="shell-icon" disabled={index === draft.sections.length - 1} onClick={() => moveSection(index, 1)} aria-label={copy(`下移${section.title}`, `Move ${section.title} down`)}><ArrowDown size={15} /></button><button className="resume-text-button" onClick={() => { setUndo(draft); setDraft({ ...draft, sections: draft.sections.filter(item => item.id !== section.id) }); }}><Trash2 size={14} />{copy("删除区块", "Remove section")}</button></div>
                  <label className="resume-field">{copy("区块名称", "Section title")}<input maxLength={200} value={section.title} onChange={event => updateSection(section.id, value => ({ ...value, title: event.target.value }))} /></label>
                  {section.entries.map((entry, entryIndex) => <div className="resume-entry-editor" key={entry.id}><div className="resume-entry-heading"><span>{copy("条目", "Entry")} {entryIndex + 1}</span><button className="shell-icon" aria-label={copy(`删除条目 ${entryIndex + 1}`, `Remove entry ${entryIndex + 1}`)} onClick={() => { setUndo(draft); updateSection(section.id, value => ({ ...value, entries: value.entries.filter(item => item.id !== entry.id) })); }}><Trash2 size={13} /></button></div>
                    {(["title", "subtitle", "period", "details"] as const).map((key, fieldIndex) => <label className="resume-field" key={key}>{[copy("职位 / 项目 / 学位", "Role / project / degree"), copy("公司 / 学校 / 补充信息", "Organization / supporting details"), copy("起止时间", "Dates"), copy("详细描述", "Description")][fieldIndex]}{key === "details" ? <textarea rows={4} maxLength={20000} value={entry[key]} placeholder={copy("写下你的职责、行动与成果，可用换行分隔要点。", "Describe your contribution and outcomes. Use new lines for separate points.")} onChange={event => updateSection(section.id, value => ({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, [key]: event.target.value } : item) }))} /> : <input maxLength={1000} value={entry[key]} onChange={event => updateSection(section.id, value => ({ ...value, entries: value.entries.map(item => item.id === entry.id ? { ...item, [key]: event.target.value } : item) }))} />}</label>)}
                  </div>)}
                  <button className="resume-text-button" disabled={section.entries.length >= 100} onClick={() => updateSection(section.id, value => ({ ...value, entries: [...value.entries, emptyEntry()] }))}><Plus size={14} />{copy("添加一条经历", "Add entry")}</button>
                </div>
              </details>)}
              <div className="resume-add-section"><h3>{copy("加入区块", "Add a section")}</h3><div>{SECTION_TYPES.map(type => <button key={type} className="resume-button" disabled={draft.sections.length >= 30} onClick={() => setDraft({ ...draft, sections: [...draft.sections, newSection(type, zh)] })}><Plus size={13} />{sectionNames[zh ? "zh" : "en"][type]}</button>)}</div></div>
            </>}
            {tab === "templates" && <><h2>{copy("选择模板", "Choose a template")}</h2><p className="resume-editor-hint">{copy("只切换排版，不改变你填写的内容。", "A new layout, with all your content preserved.")}</p>{TEMPLATE_IDS.map(template => <button className="resume-template-option" key={template} aria-pressed={draft.template === template} onClick={() => selectTemplate(template)}><LayoutTemplate size={20} /><span><strong>{templates[template][0]}</strong><small>{templates[template][1]}</small></span>{draft.template === template && <Check size={17} />}</button>)}</>}
          </div>
        </section>
      </div></fieldset>
    </>}
    {view === "editor" && draft && <div className="resume-print-root" aria-hidden><ResumePaper resume={draft} zh={zh} /></div>}
  </main>;
}
