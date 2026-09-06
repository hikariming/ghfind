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


describe("résumé portraits", () => {
  it("loads old drafts without a photo and preserves portraits across layout changes", () => {
    const old = createResume("editorial", true);
    expect(readResumeLibrary(serializeResumeLibrary([old]))[0].photo).toBeUndefined();
    const withPhoto = { ...old, template: "noir" as const, photo: { data: "data:image/jpeg;base64,/9j/2Q==", position: 35 } };
    const restored = readResumeLibrary(serializeResumeLibrary([withPhoto]))[0];
    expect(restored.photo).toEqual(withPhoto.photo);
    expect(upsertResume([restored], { ...restored, template: "classic" })[0].photo).toEqual(withPhoto.photo);
    expect(readResumeLibrary(serializeResumeLibrary([{ ...restored, photo: undefined }]))[0].photo).toBeUndefined();
  });
  it("rejects external URLs, invalid crops and oversized embedded photos", () => {
    const draft = createResume("noir", true);
    for (const photo of [{ data: "https://example.com/photo.jpg", position: 50 }, { data: "data:image/jpeg;base64,AAAA", position: 101 }, { data: "data:image/jpeg;base64," + "A".repeat(700000), position: 50 }]) {
      expect(() => serializeResumeLibrary([{ ...draft, photo }])).toThrow();
    }
  });
});
