import type { Resume } from "@/lib/resume";

export function ResumePaper({ resume, zh, miniature = false }: { resume: Resume; zh: boolean; miniature?: boolean }) {
  const { basics } = resume;
  const contacts = [basics.email, basics.phone, basics.city, basics.website].filter(Boolean);
  return <article className={`resume-paper resume-paper-${resume.template}`} aria-label={miniature ? undefined : zh ? "简历实时预览" : "Live résumé preview"} aria-hidden={miniature || undefined}>
    <header className="resume-paper-header">
      <div className="resume-paper-monogram" aria-hidden>{(basics.name || "G").slice(0, 1)}</div>
      <div><h2>{basics.name || (zh ? "你的姓名" : "Your name")}</h2><p className="resume-paper-role">{basics.role || (zh ? "职位 / 职业方向" : "Role / career focus")}</p></div>
    </header>
    {contacts.length > 0 && <p className="resume-paper-contact">{contacts.join("  ·  ")}</p>}
    {basics.summary && <p className="resume-paper-summary">{basics.summary}</p>}
    <div className="resume-paper-sections">
      {resume.sections.map(section => <section className="resume-paper-section" key={section.id}>
        <h3>{section.title}</h3>
        <div>{section.entries.map(entry => <div className="resume-paper-entry" key={entry.id}>
          {(entry.title || entry.period) && <div className="resume-paper-entry-heading"><h4>{entry.title}</h4><span>{entry.period}</span></div>}
          {entry.subtitle && <p className="resume-paper-subtitle">{entry.subtitle}</p>}
          {entry.details && <p className="resume-paper-details">{entry.details}</p>}
        </div>)}
        {!section.entries.some(entry => entry.title || entry.subtitle || entry.period || entry.details) && !miniature && <p className="resume-paper-empty">{zh ? "在右侧填写内容，这里将实时呈现。" : "Add content in the editor to see it here."}</p>}
        </div>
      </section>)}
    </div>
  </article>;
}
