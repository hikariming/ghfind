import { UserRound } from "lucide-react";
import type { Resume, ResumeSection } from "@/lib/resume";

export function ResumePaper({ resume, zh, miniature = false }: { resume: Resume; zh: boolean; miniature?: boolean }) {
  const { basics, photo } = resume;
  const noir = resume.template === "noir";
  const contacts = [basics.email, basics.phone, basics.city, basics.website].filter(Boolean);
  const portrait = photo ? (
    // eslint-disable-next-line @next/next/no-img-element -- photo is a compressed browser-local data URL
    <img className="resume-paper-photo" src={photo.data} alt={zh ? "个人照片" : "Portrait"} style={{ objectPosition: `center ${photo.position}%` }} />
  ) : miniature && noir ? <div className="resume-paper-photo resume-paper-photo-sample"><UserRound strokeWidth={.7} aria-hidden /></div> : null;
  const sectionView = (section: ResumeSection) => <section className="resume-paper-section" key={section.id}>
    <h3>{section.title}</h3>
    <div>{section.entries.map(entry => <div className="resume-paper-entry" key={entry.id}>
      {(entry.title || entry.period) && <div className="resume-paper-entry-heading"><h4>{entry.title}</h4><span>{entry.period}</span></div>}
      {entry.subtitle && <p className="resume-paper-subtitle">{entry.subtitle}</p>}
      {entry.details && <p className="resume-paper-details">{entry.details}</p>}
    </div>)}
    {!section.entries.some(entry => entry.title || entry.subtitle || entry.period || entry.details) && !miniature && <p className="resume-paper-empty">{zh ? "在右侧填写内容，这里将实时呈现。" : "Add content in the editor to see it here."}</p>}
    </div>
  </section>;
  const sideSection = (section: ResumeSection) => section.type === "education" || section.type === "skills";
  return <article className={`resume-paper resume-paper-${resume.template}`} aria-label={miniature ? undefined : zh ? "简历实时预览" : "Live résumé preview"} aria-hidden={miniature || undefined}>
    <header className="resume-paper-header">
      {!photo && <div className="resume-paper-monogram" aria-hidden>{(basics.name || "G").slice(0, 1)}</div>}
      <div className="resume-paper-identity"><h2>{basics.name || (zh ? "你的姓名" : "Your name")}</h2><p className="resume-paper-role">{basics.role || (zh ? "职位 / 职业方向" : "Role / career focus")}</p></div>
      {!noir && portrait}
      {noir && <div className="resume-noir-contacts">{[["M", basics.phone], ["@", basics.email], ["W", basics.website], ["↗", basics.city]].filter(([, value]) => value).map(([label, value]) => <p key={label}><strong>{label}</strong><span>{value}</span></p>)}</div>}
    </header>
    {noir ? <div className="resume-noir-columns"><div>
      {basics.summary && <section className="resume-paper-section resume-noir-summary"><h3>{zh ? "个人简介" : "Summary"}</h3><p>{basics.summary}</p></section>}
      {resume.sections.filter(section => !sideSection(section)).map(sectionView)}
    </div><aside>{portrait}{resume.sections.filter(sideSection).map(sectionView)}</aside></div> : <>
      {contacts.length > 0 && <p className="resume-paper-contact">{contacts.join("  ·  ")}</p>}
      {basics.summary && <p className="resume-paper-summary">{basics.summary}</p>}
      <div className="resume-paper-sections">{resume.sections.map(sectionView)}</div>
    </>}
  </article>;
}
