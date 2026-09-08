package backend

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
)

func feedProjectDTO(p FeedProject) FeedProjectDTO {
	return FeedProjectDTO{FeedProject: p, ItemID: p.ItemID, Publishable: p.Publishable, SubmissionEvidence: p.SubmissionEvidence}
}
func (d FeedProjectDTO) project() FeedProject {
	p := d.FeedProject
	p.ItemID = d.ItemID
	p.Publishable = d.Publishable
	p.SubmissionEvidence = d.SubmissionEvidence
	return p
}
func feedUserDTO(u FeedUser) FeedUserDTO {
	return FeedUserDTO{FeedUser: u, Embedding: u.Embedding, EmbeddingModel: u.embeddingModel, EmbeddingDimensions: u.embeddingDimensions}
}
func (d FeedUserDTO) user() FeedUser {
	u := d.FeedUser
	u.Embedding = d.Embedding
	u.embeddingModel = d.EmbeddingModel
	u.embeddingDimensions = d.EmbeddingDimensions
	return u
}
func feedRankedItemDTO(i FeedRankedItem) FeedRankedItemDTO {
	return FeedRankedItemDTO{Project: feedProjectDTO(i.Project), CandidateSources: i.CandidateSources, ReasonCodes: i.ReasonCodes, Score: i.Score, Rank: i.Rank, Exploration: i.Exploration, Propensity: i.Propensity, Features: i.Features}
}
func (d FeedRankedItemDTO) item() FeedRankedItem {
	return FeedRankedItem{Project: d.Project.project(), CandidateSources: d.CandidateSources, ReasonCodes: d.ReasonCodes, Score: d.Score, Rank: d.Rank, Exploration: d.Exploration, Propensity: d.Propensity, Features: d.Features}
}
func (d FeedCandidateDTO) candidate() FeedCandidate {
	return FeedCandidate{Project: d.Project.project(), Sources: d.Sources, TagAffinity: d.TagAffinity, SemanticSimilarity: d.SemanticSimilarity, Embedding: d.Embedding, SeenAt: d.SeenAt, NotInterested: d.NotInterested}
}
func feedSessionDTO(s FeedSession) FeedSessionDTO {
	d := FeedSessionDTO{ID: s.ID, GitHubID: s.GitHubID, AlgorithmVersion: s.AlgorithmVersion, TaxonomyVersion: s.TaxonomyVersion, ProfileVersion: s.ProfileVersion, PageSize: s.PageSize, Seed: s.Seed, CandidateCounts: s.CandidateCounts, Degraded: s.Degraded, CreatedAt: s.CreatedAt, ExpiresAt: s.ExpiresAt, Items: make([]FeedRankedItemDTO, 0, len(s.Items))}
	for _, item := range s.Items {
		d.Items = append(d.Items, feedRankedItemDTO(item))
	}
	return d
}
func (d FeedSessionDTO) session() FeedSession {
	s := FeedSession{ID: d.ID, GitHubID: d.GitHubID, AlgorithmVersion: d.AlgorithmVersion, TaxonomyVersion: d.TaxonomyVersion, ProfileVersion: d.ProfileVersion, PageSize: d.PageSize, Seed: d.Seed, CandidateCounts: d.CandidateCounts, Degraded: d.Degraded, CreatedAt: d.CreatedAt, ExpiresAt: d.ExpiresAt, Items: make([]FeedRankedItem, 0, len(d.Items))}
	for _, item := range d.Items {
		s.Items = append(s.Items, item.item())
	}
	return s
}

func feedRequestPayloadHash(r FeedRequestRecord) (string, error) {
	dto := FeedBridgeSaveRequest{AlgorithmVersion: feedRequestAlgorithm(r), ID: r.ID, User: feedUserDTO(r.User), Seed: r.Seed, CandidateCounts: r.CandidateCounts, Degraded: r.Degraded, DurationMS: r.Duration.Milliseconds(), Items: []FeedRankedItemDTO{}}
	for _, item := range r.Items {
		dto.Items = append(dto.Items, feedRankedItemDTO(item))
	}
	encoded, err := json.Marshal(dto)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return fmt.Sprintf("%x", hash), nil
}
