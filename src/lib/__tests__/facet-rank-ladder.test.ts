import { describe, expect, it } from "vitest";
import { rankOnLadder } from "../db";

const ladder = {
  usernames: ["alice", "bob", "carol", "dave", "erin"],
  scores: [95, 90, 90, 80, 70],
};

describe("rankOnLadder", () => {
  it("ranks by members strictly above, ties sharing a rank", () => {
    expect(rankOnLadder(ladder, "Rust", 90)).toEqual({
      facetType: "language",
      facetValue: "Rust",
      rank: 2,
      total: 5,
      ahead: { username: "alice", final_score: 95 },
    });
    expect(rankOnLadder(ladder, "Rust", 80)?.rank).toBe(4);
  });

  it("names the lowest-scoring member strictly above as ahead", () => {
    expect(rankOnLadder(ladder, "Rust", 80)?.ahead).toEqual({ username: "carol", final_score: 90 });
    expect(rankOnLadder(ladder, "Rust", 85)).toMatchObject({ rank: 4, ahead: { username: "carol" } });
  });

  it("has no one ahead at the top and counts everyone below the top", () => {
    expect(rankOnLadder(ladder, "Rust", 95)).toMatchObject({ rank: 1, ahead: null });
    expect(rankOnLadder(ladder, "Rust", 99)).toMatchObject({ rank: 1, ahead: null });
    expect(rankOnLadder(ladder, "Rust", 60)).toMatchObject({ rank: 6, ahead: { username: "erin" } });
  });

  it("returns null for a bucket with one or no ranked developer", () => {
    expect(rankOnLadder({ usernames: ["solo"], scores: [80] }, "Zig", 80)).toBeNull();
    expect(rankOnLadder({ usernames: [], scores: [] }, "Zig", 80)).toBeNull();
  });
});
