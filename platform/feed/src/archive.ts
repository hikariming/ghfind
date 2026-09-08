// Typed archive capability used by bounded executor jobs. Keys are versioned and
// actor-scoped; no public HTTP object proxy or arbitrary bucket enumeration.
export class FeedArchive {
  constructor(private readonly bucket: R2Bucket) {}
  key(githubId: number, generation: number, id: string) {
    if (
      !Number.isSafeInteger(githubId) ||
      githubId <= 0 ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(id)
    )
      throw new Error("invalid_archive_key");
    return `feed/v1/users/${githubId}/${generation}/${id}.json`;
  }
  async put(
    githubId: number,
    generation: number,
    id: string,
    body: Uint8Array,
  ) {
    if (body.byteLength > 4 * 1024 * 1024) throw new Error("archive_too_large");
    const key = this.key(githubId, generation, id);
    return this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
  }
  get(githubId: number, generation: number, id: string) {
    return this.bucket.get(this.key(githubId, generation, id));
  }
  async deleteBatch(githubId: number, generation: number, cursor?: string) {
    const prefix = this.key(githubId, generation, "placeholder").replace(
      "placeholder.json",
      "",
    );
    const page = await this.bucket.list({ prefix, cursor, limit: 100 });
    if (page.objects.length)
      await this.bucket.delete(page.objects.map((object) => object.key));
    return {
      deleted: page.objects.length,
      cursor: page.truncated ? page.cursor : undefined,
      complete: !page.truncated,
    };
  }
}
