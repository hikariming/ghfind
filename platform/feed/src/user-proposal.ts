// The author association survives profile deletion until every attributed copy
// has been erased. Missing provenance is quarantined, never treated as consent.
export const liveUserProposal = (alias = "q") =>
  `EXISTS(SELECT 1 FROM feed_user_proposal_authors a JOIN feed_users u ON u.github_id=a.github_id
   WHERE a.proposal_id=${alias}.id AND a.redacted_at IS NULL AND a.profile_version<=u.profile_version
   AND a.profile_version>COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=a.github_id),0))`;
