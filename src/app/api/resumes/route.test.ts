import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createResume, profileFromResume, readResumeLibrary, readResumeLibraryFull, sampleResume, serializeResumeLibrary } from "@/lib/resume";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authConfigured: () => true, auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ getResumeLibrary: mocks.get, saveResumeLibrary: mocks.save }));
import { GET, PUT } from "./route";
const request = (body: unknown) => new NextRequest("https://example.com/api/resumes", { method: "PUT", body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { githubId: 12, login: "example" } });
  mocks.get.mockResolvedValue(null);
  mocks.save.mockResolvedValue("saved");
});
describe("cloud résumé saving", () => {
  it("distinguishes signed-out, empty and unavailable states", async () => {
    expect(await (await GET()).json()).toEqual({ data: null });
    mocks.get.mockResolvedValue(undefined);
    expect((await GET()).status).toBe(503);
    mocks.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(request({}))).status).toBe(401);
  });
  it("saves the current document while preserving other cloud documents", async () => {
    const other = createResume("classic", true);
    const data = serializeResumeLibrary([other]);
    mocks.get.mockResolvedValue({ data, updatedAt: 1 });
    const resume = createResume("noir", true);
    resume.basics.name = "Current edit";
    const result = await PUT(request({ resume, baseUpdatedAt: null }));
    expect(result.status).toBe(200);
    const [id, login, written, expected] = mocks.save.mock.calls[0];
    expect([id, login, expected]).toEqual([12, "example", data]);
    const library = readResumeLibrary(written);
    expect(library[0].basics.name).toBe("Current edit");
    expect(library[1]).toEqual(other);
    expect((await result.json()).resume.updatedAt).toBe(library[0].updatedAt);
  });
  it("rejects stale edits without changing the cloud version", async () => {
    const resume = { ...createResume("modern", true), updatedAt: "new-version" };
    mocks.get.mockResolvedValue({ data: serializeResumeLibrary([resume]), updatedAt: 1 });
    expect((await PUT(request({ resume: { ...resume, name: "My newer edits" }, baseUpdatedAt: "old-version" }))).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rechecks after a concurrent save instead of erasing it", async () => {
    const resume = createResume("modern", true);
    mocks.get.mockResolvedValueOnce(null).mockResolvedValue({ data: serializeResumeLibrary([{ ...resume, name: "Other device edits", updatedAt: "concurrent-version" }]), updatedAt: 1 });
    mocks.save.mockResolvedValue("conflict");
    expect((await PUT(request({ resume, baseUpdatedAt: null }))).status).toBe(409);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite unavailable or corrupt cloud storage", async () => {
    mocks.get.mockResolvedValue({ data: "invalid", updatedAt: 1 });
    expect((await PUT(request({ resume: createResume("classic", true), baseUpdatedAt: null }))).status).toBe(503);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("refuses whole-library replacement and oversized uploads", async () => {
    expect((await PUT(request({ data: serializeResumeLibrary([]) }))).status).toBe(400);
    expect((await PUT(request({ padding: "x".repeat(900001) }))).status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns an explicit error if the database write fails", async () => {
    mocks.save.mockResolvedValue("unavailable");
    expect((await PUT(request({ resume: createResume("classic", true), baseUpdatedAt: null }))).status).toBe(503);
  });
  it("preserves the stored profile across document saves", async () => {
    const other = createResume("classic", true);
    const profile = profileFromResume(sampleResume("modern", true));
    mocks.get.mockResolvedValue({ data: serializeResumeLibrary([other], profile), updatedAt: 1 });
    const resume = createResume("noir", true);
    const result = await PUT(request({ resume, baseUpdatedAt: null }));
    expect(result.status).toBe(200);
    const written = readResumeLibraryFull(mocks.save.mock.calls[0][2]);
    expect(written.profile).toEqual(profile);
    expect(written.resumes.map(item => item.id)).toEqual([resume.id, other.id]);
  });
  it("saves reusable data without a document and keeps every document untouched", async () => {
    const other = createResume("editorial", true);
    const data = serializeResumeLibrary([other]);
    mocks.get.mockResolvedValue({ data, updatedAt: 1 });
    const profile = profileFromResume(sampleResume("classic", false));
    const result = await PUT(request({ profile }));
    expect(result.status).toBe(200);
    expect((await result.json()).profile).toEqual(profile);
    const [id, login, written, expected] = mocks.save.mock.calls[0];
    expect([id, login, expected]).toEqual([12, "example", data]);
    const stored = readResumeLibraryFull(written);
    expect(stored.resumes).toEqual([other]);
    expect(stored.profile).toEqual(profile);
  });
  it("rejects invalid profile bodies and still refuses empty saves", async () => {
    expect((await PUT(request({ profile: { basics: {}, sections: [] } }))).status).toBe(400);
    expect((await PUT(request({}))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

it("allows an identical retry after the successful response was lost", async () => {
  const resume = { ...createResume("classic", true), updatedAt: "server-version" };
  mocks.get.mockResolvedValue({ data: serializeResumeLibrary([resume]), updatedAt: 1 });
  const res = await PUT(request({ resume: { ...resume, updatedAt: "old-local-time" }, baseUpdatedAt: null }));
  expect(res.status).toBe(200);
  expect((await res.json()).resume.updatedAt).toBe("server-version");
  expect(mocks.save).not.toHaveBeenCalled();
});
