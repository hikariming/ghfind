import { describe, expect, it } from "vitest";
import { createResume, readResumeLibrary, serializeResumeLibrary, upsertResume } from "../resume";

describe("local résumé persistence", () => {
  it("round-trips personal data, sections and layout without merging distinct documents", () => {
    const first = createResume("editorial", true);
    first.basics.name = "测试姓名";
    first.sections[0].entries[0].details = "第一行\n第二行 <not-html>";
    const second = createResume("classic", true);
    const library = upsertResume(upsertResume([], first), second);
    expect(readResumeLibrary(serializeResumeLibrary(library))).toEqual([second, first]);
    const updated = { ...first, template: "modern" as const, updatedAt: "2026-09-06T00:00:00Z" };
    expect(upsertResume(library, updated)).toEqual([updated, second]);
    expect(updated.basics.name).toBe("测试姓名");
    expect(updated.sections[0].entries[0].details).toBe("第一行\n第二行 <not-html>");
  });
  it("rejects invalid or unknown storage instead of treating it as empty and overwriting it", () => {
    expect(readResumeLibrary(null)).toEqual([]);
    for (const raw of ["not json", '{"version":2,"resumes":[]}', '{"version":1,"resumes":[{}]}', '{"version":1,"resumes":"wrong"}']) {
      expect(() => readResumeLibrary(raw)).toThrow();
    }
  });
  it("starts a new résumé without sample personal information", () => {
    const draft = createResume("modern", true);
    expect(Object.values(draft.basics).every(value => value === "")).toBe(true);
    expect(draft.sections).toHaveLength(4);
    expect(new Set(draft.sections.map(section => section.id)).size).toBe(4);
  });
});
