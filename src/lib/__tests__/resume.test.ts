import { describe, expect, it } from "vitest";
import { createResume, isResumeEmpty, profileFromResume, readResumeLibrary, readResumeLibraryFull, resumeStorageSnapshot, sampleResume, serializeResumeLibrary, TEMPLATE_IDS, upsertResume } from "../resume";

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

describe("reusable résumé data (profile)", () => {
  it("extracts content without the photo and round-trips it through the library payload", () => {
    const resume = sampleResume("modern", true);
    resume.photo = { data: "data:image/jpeg;base64,/9j/2Q==", position: 50 };
    const profile = profileFromResume(resume);
    expect(profile.basics).toEqual(resume.basics);
    expect(profile.sections).toEqual(resume.sections);
    expect("photo" in profile).toBe(false);
    expect(Date.parse(profile.updatedAt)).not.toBeNaN();
    const stored = serializeResumeLibrary([resume], profile);
    const restored = readResumeLibraryFull(stored);
    expect(restored.profile).toEqual(profile);
    expect(restored.resumes).toEqual([resume]);
    expect(readResumeLibrary(stored)).toEqual([resume]);
  });
  it("keeps profile-less and empty libraries readable", () => {
    const resume = createResume("classic", true);
    expect(readResumeLibraryFull(serializeResumeLibrary([resume]))).toEqual({ resumes: [resume] });
    expect(readResumeLibraryFull(null)).toEqual({ resumes: [] });
  });
  it("parses stored profiles without a name and keeps explicit names", () => {
    const legacy = JSON.parse(serializeResumeLibrary([], profileFromResume(sampleResume("classic", true)))) as { profile: Record<string, unknown> };
    delete legacy.profile.name;
    expect(readResumeLibraryFull(JSON.stringify(legacy)).profile?.name).toBeUndefined();
    const named = readResumeLibraryFull(serializeResumeLibrary([], profileFromResume(sampleResume("classic", true), "主数据"))).profile;
    expect(named?.name).toBe("主数据");
    expect(profileFromResume(sampleResume("classic", true), "   ").name).toBeUndefined();
  });
  it("detects blank résumés, including whitespace-only and scaffolded ones", () => {
    expect(isResumeEmpty(createResume("editorial", true))).toBe(true);
    const whitespace = createResume("editorial", true);
    whitespace.basics.name = "   ";
    whitespace.sections[0].entries[0].details = " \n ";
    expect(isResumeEmpty(whitespace)).toBe(true);
    const filled = createResume("editorial", true);
    filled.sections[0].entries[0].title = "Engineer";
    expect(isResumeEmpty(filled)).toBe(false);
    expect(isResumeEmpty(sampleResume("noir", false))).toBe(false);
  });
});

describe("sample résumé content", () => {
  // "Fill sample data" and the cloud-sync payload validation share this path:
  // every template's illustrative content must survive a library round-trip.
  it("round-trips through the library schema in both languages for every template", () => {
    for (const template of TEMPLATE_IDS) {
      for (const zh of [true, false]) {
        const sample = sampleResume(template, zh);
        expect(sample.basics.name).not.toBe("");
        expect(readResumeLibrary(serializeResumeLibrary([sample]))).toEqual([sample]);
      }
    }
  });
});

it("does not treat schema property reordering after a cloud save as another tab's edit", () => {
  const saved = { ...createResume("modern", true), updatedAt: "version-1", cloudBase: { account: "example", updatedAt: "cloud-version" } };
  const restored = readResumeLibrary(serializeResumeLibrary([saved]))[0];
  expect(resumeStorageSnapshot(saved)).toBe(resumeStorageSnapshot(restored));
  expect(resumeStorageSnapshot({ ...restored, name: "Another tab" })).not.toBe(resumeStorageSnapshot(saved));
});
