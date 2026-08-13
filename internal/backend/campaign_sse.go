package backend

import (
	"context"
	"errors"
	"sync"
	"time"
)

const (
	campaignRevisionPollInterval = 2 * time.Second
	campaignStreamLifetime       = 55 * time.Second
	maxCampaignStreams           = 64
)

type CampaignRevisionStore interface {
	GetCampaignLeaderboardRevision(context.Context, string) (*int64, error)
}

var errCampaignStreamCap = errors.New("campaign stream capacity reached")

type campaignRevisionChannel struct {
	campaign  string
	revision  int64
	listeners map[chan int64]struct{}
	stop      chan struct{}
}

// campaignSSEHub shares one Upstash poller per campaign per Go API instance,
// matching the old Next process's fan-out behavior without opening one Redis
// poll per EventSource connection.
type campaignSSEHub struct {
	store        CampaignRevisionStore
	pollInterval time.Duration
	mu           sync.Mutex
	channels     map[string]*campaignRevisionChannel
}

func newCampaignSSEHub(store CampaignRevisionStore) *campaignSSEHub {
	return &campaignSSEHub{
		store: store, pollInterval: campaignRevisionPollInterval, channels: map[string]*campaignRevisionChannel{},
	}
}

func (h *campaignSSEHub) subscribe(ctx context.Context, campaign string) (<-chan int64, func(), error) {
	h.mu.Lock()
	channel := h.channels[campaign]
	if channel == nil {
		readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		revision, err := h.store.GetCampaignLeaderboardRevision(readCtx, campaign)
		cancel()
		if err != nil {
			h.mu.Unlock()
			return nil, nil, err
		}
		// A missing revision key only means nobody has joined the campaign
		// recently (the writer INCRs it with a 7-day TTL). Start the stream at
		// 0 so the endpoint stays available instead of 503ing until the next
		// join; the poller picks up the first bump from there.
		initial := int64(0)
		if revision != nil {
			initial = *revision
		}
		channel = &campaignRevisionChannel{
			campaign: campaign, revision: initial, listeners: map[chan int64]struct{}{}, stop: make(chan struct{}),
		}
		h.channels[campaign] = channel
		go h.poll(channel)
	}
	if len(channel.listeners) >= maxCampaignStreams {
		h.mu.Unlock()
		return nil, nil, errCampaignStreamCap
	}
	listener := make(chan int64, 1)
	channel.listeners[listener] = struct{}{}
	h.mu.Unlock()

	var once sync.Once
	return listener, func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			current := h.channels[campaign]
			if current != channel {
				return
			}
			delete(channel.listeners, listener)
			close(listener)
			if len(channel.listeners) == 0 {
				delete(h.channels, campaign)
				close(channel.stop)
			}
		})
	}, nil
}

func (h *campaignSSEHub) poll(channel *campaignRevisionChannel) {
	ticker := time.NewTicker(h.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-channel.stop:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			next, err := h.store.GetCampaignLeaderboardRevision(ctx, channel.campaign)
			cancel()
			if err != nil || next == nil {
				continue
			}
			h.mu.Lock()
			if h.channels[channel.campaign] != channel {
				h.mu.Unlock()
				return
			}
			if *next != channel.revision {
				channel.revision = *next
				for listener := range channel.listeners {
					select {
					case listener <- *next:
					default:
						// One slow client must not block the campaign's other streams.
					}
				}
			}
			h.mu.Unlock()
		}
	}
}
