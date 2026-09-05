"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, FileText, HardDrive, LayoutTemplate, Plus, Save, Trash2, Undo2 } from "lucide-react";
import { createResume, emptyEntry, newSection, readResumeLibrary, RESUME_STORAGE_KEY, sampleResume, SECTION_TYPES, sectionNames, serializeResumeLibrary, TEMPLATE_IDS, upsertResume, type Resume, type ResumeSection, type TemplateId } from "@/lib/resume";
import { ResumePaper } from "./ResumePaper";

const templateCopy = {
  zh: { editorial: ["清爽双栏", "克制的层次与留白，适合产品与技术岗位。"], modern: ["现代蓝调", "鲜明的个人标识，让经历更容易被看见。"], classic: ["经典排版", "简洁、正式，让内容成为第一主角。"] },
  en: { editorial: ["Editorial", "Clear hierarchy for product and engineering roles."], modern: ["Modern", "A distinctive identity and a confident blue accent."], classic: ["Classic", "Quiet, considered typography that puts content first."] },
};

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
  const dirty = draft !== null && JSON.stringify(draft) !== savedSnapshot;

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
    setDraft(createResume(template, zh)); setSavedSnapshot(""); setView("editor"); setTab("basics"); setUndo(null); setNotice("");
  }
  function openResume(resume: Resume) {
    if (!canReplace()) return;
    setDraft(resume); setSavedSnapshot(JSON.stringify(resume)); setView("editor"); setTab("basics"); setUndo(null); setNotice("");
  }
  function save() {
    if (!draft) return;
    try {
      // Re-read before writing to preserve other drafts saved in another tab.
      const latest = readResumeLibrary(localStorage.getItem(RESUME_STORAGE_KEY));
      const previous = latest.find(item => item.id === draft.id);
      if (previous && previous.updatedAt !== draft.updatedAt) {
        setError(copy("这份简历已在另一个标签页更新。为避免覆盖，请先复制当前内容，再从模板页重新打开已保存版本。", "This résumé changed in another tab. Copy your edits and reopen the saved version before continuing.")); return;
      }
      const saved = { ...draft, name: draft.name.trim() || copy("未命名简历", "Untitled résumé"), updatedAt: new Date().toISOString() };
      const next = upsertResume(latest, saved);
      localStorage.setItem(RESUME_STORAGE_KEY, serializeResumeLibrary(next));
      setLibrary(next); setDraft(saved); setSavedSnapshot(JSON.stringify(saved)); setError(""); setNotice(copy("已保存到此浏览器", "Saved in this browser"));
    } catch {
      setError(copy("保存失败：浏览器存储不可用、空间已满或现有数据无法读取。编辑内容仍在页面中，请先复制备份后再重试。", "Save failed: browser storage is unavailable, full, or contains unreadable data. Your edits remain on this page; copy them before retrying."));
    }
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

  const localNotice = <div className="resume-local-note"><HardDrive size={17} aria-hidden /><p>{copy("简历仅保存在当前浏览器的本地存储中，尚未同步到数据库。更换浏览器、设备或清除网站数据后，将无法找回。编辑后请点击「保存简历」。", "Résumés are stored only in this browser, not in a database. They will not follow you to another browser or device, and clearing site data removes them. Click Save résumé after editing.")}</p></div>;

  return <main className={`resume-app ${view === "editor" ? "resume-is-editing" : ""}`}>
    <header className="resume-page-heading">
      <div><div className="resume-eyebrow">G H F I N D / CAREER</div><h1>{copy("我的简历", "My résumés")} <span className="resume-beta">{copy("预览版", "Preview")}</span></h1><p>{copy("把你的经历，整理成下一次机会。", "Make room for your next opportunity.")}</p></div>
      {view === "editor" && <div className="resume-header-actions"><button className="resume-button" onClick={() => setView("gallery")}><ArrowLeft size={15} />{copy("模板与简历", "Templates & résumés")}</button><button className="resume-button resume-button-primary" onClick={save}><Save size={15} />{copy("保存简历", "Save résumé")}</button></div>}
    </header>
    {localNotice}
    {error && <p className="resume-error" role="alert">{error}</p>}
    {!ready ? <p className="resume-loading">{copy("正在读取本地简历…", "Reading local résumés…")}</p> : view === "gallery" ? <>
      {(library.length > 0 || draft) && <section className="resume-library"><div className="resume-section-heading"><h2>{copy("本地简历", "Local résumés")}</h2>{draft && <button className="resume-text-button" onClick={() => setView("editor")}>{copy("继续当前编辑", "Continue editing")} <ArrowRight size={14} /></button>}</div>
        <div className="resume-saved-list">{library.map(resume => <button key={resume.id} className="resume-saved-item" onClick={() => openResume(resume)}><FileText size={22} /><span><strong>{resume.name}</strong><small>{templates[resume.template][0]} · {new Date(resume.updatedAt).toLocaleString(zh ? "zh-CN" : "en-GB")}</small></span><ArrowRight size={16} /></button>)}</div>
      </section>}
      <section className="resume-template-gallery"><div className="resume-section-heading"><div><h2>{copy("从一个好看的模板开始", "Start with a considered template")}</h2><p>{copy("三种风格，同一份内容。进入编辑器后也可以随时更换。下方为示例排版。", "Three styles, the same story. Switch templates any time. Thumbnails show sample content.")}</p></div><span className="resume-section-count">01 — 03</span></div>
        <div className="resume-template-grid">{TEMPLATE_IDS.map((template, index) => <button key={template} className="resume-template-card" onClick={() => begin(template)}><div className="resume-template-thumbnail"><ResumePaper resume={sampleResume(template, zh)} zh={zh} miniature /></div><div className="resume-template-caption"><span className="resume-template-index">0{index + 1}</span><div><h3>{templates[template][0]}</h3><p>{templates[template][1]}</p></div><ArrowRight size={18} /></div><span className="resume-template-use">{copy("使用此模板", "Use template")} <ArrowRight size={14} /></span></button>)}</div>
      </section>
    </> : draft && <>
      <div className="resume-document-bar"><label>{copy("简历名称", "Document name")}<input value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><span role="status" className="resume-save-status">{dirty ? copy("有未保存的修改", "Unsaved changes") : notice || copy("已保存到此浏览器", "Saved in this browser")}{!dirty && <Check size={14} />}</span></div>
      <div className="resume-mobile-switch"><button aria-pressed={mobilePanel === "edit"} onClick={() => setMobilePanel("edit")}>{copy("编辑内容", "Edit")}</button><button aria-pressed={mobilePanel === "preview"} onClick={() => setMobilePanel("preview")}>{copy("简历预览", "Preview")}</button></div>
      <div className="resume-studio" data-mobile-panel={mobilePanel}>
        <section className="resume-preview-pane"><div className="resume-pane-heading"><span>{copy("实时预览", "Live preview")}</span><span>{templates[draft.template][0]}</span></div><div className="resume-paper-stage"><ResumePaper resume={draft} zh={zh} /></div><p className="resume-preview-caption">{copy("预览会随输入更新 · 内容较长时纸张自动延展", "Preview updates as you type · The page grows with your content")}</p></section>
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
            {tab === "basics" && <><h2>{copy("先认识一下你", "Start with you")}</h2><p className="resume-editor-hint">{copy("填写你希望展示的信息，留空的字段不会显示。", "Only the fields you fill in will appear.")}</p>
              <div className="resume-fields">{(["name", "role", "email", "phone", "city", "website"] as const).map((key, index) => <label key={key}>{[copy("姓名", "Name"), copy("求职方向 / 职位", "Role / career focus"), copy("邮箱", "Email"), copy("电话", "Phone"), copy("所在城市", "Location"), copy("个人网站 / GitHub", "Website / GitHub")][index]}<input type={key === "email" ? "email" : "text"} autoComplete="off" value={draft.basics[key]} maxLength={500} placeholder={[copy("你的姓名", "Your name"), copy("例如：前端工程师", "e.g. Frontend Engineer"), "hello@example.com", copy("选填", "Optional"), copy("例如：上海", "e.g. London"), "github.com/username"][index]} onChange={event => { setDraft({ ...draft, basics: { ...draft.basics, [key]: event.target.value } }); setNotice(""); }} /></label>)}</div>
              <label className="resume-field">{copy("个人简介", "Summary")}<textarea rows={5} maxLength={20000} value={draft.basics.summary} placeholder={copy("用两三句话介绍你的方向、擅长的领域和代表性成果。", "Introduce your focus, strengths and a meaningful achievement.")} onChange={event => setDraft({ ...draft, basics: { ...draft.basics, summary: event.target.value } })} /></label>
              <button className="resume-button resume-next" onClick={() => setTab("sections")}>{copy("接下来，补充经历", "Next, add your experience")}<ArrowRight size={15} /></button>
            </>}
            {tab === "sections" && <><div className="resume-section-heading"><h2>{copy("让经历有条理", "Shape your story")}</h2>{undo && <button className="resume-text-button" onClick={() => { setDraft({ ...undo, updatedAt: draft.updatedAt }); setUndo(null); }}><Undo2 size={14} />{copy("撤销删除", "Undo delete")}</button>}</div><p className="resume-editor-hint">{copy("展开区块编辑；用箭头调整顺序。每个区块可添加多条经历。", "Expand a section to edit it. Reorder with arrows and add multiple entries.")}</p>
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
            {tab === "templates" && <><h2>{copy("换一种表达", "A different expression")}</h2><p className="resume-editor-hint">{copy("只切换排版，不改变你填写的内容。", "A new layout, with all your content preserved.")}</p>{TEMPLATE_IDS.map(template => <button className="resume-template-option" key={template} aria-pressed={draft.template === template} onClick={() => selectTemplate(template)}><LayoutTemplate size={20} /><span><strong>{templates[template][0]}</strong><small>{templates[template][1]}</small></span>{draft.template === template && <Check size={17} />}</button>)}</>}
          </div>
        </section>
      </div>
    </>}
  </main>;
}
