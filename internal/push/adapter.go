package push

import (
	"context"

	"github.com/teckdroids/ges-data-engine/internal/repository"
)

// RepoAdapter wraps *repository.PostgresRepo so it satisfies the
// push.SubscriptionStore interface without the push package importing
// repository types in its core API.
type RepoAdapter struct {
	Repo *repository.PostgresRepo
}

func (a *RepoAdapter) ListPushSubscriptions(ctx context.Context, userID int) ([]Subscription, error) {
	rows, err := a.Repo.ListPushSubscriptions(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Subscription, len(rows))
	for i, r := range rows {
		out[i] = Subscription{
			Endpoint:   r.Endpoint,
			P256dh:     r.P256dh,
			AuthSecret: r.AuthSecret,
		}
	}
	return out, nil
}

func (a *RepoAdapter) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	return a.Repo.DeletePushSubscriptionByEndpoint(ctx, endpoint)
}

func (a *RepoAdapter) ListWatchListsForPushSubscribers(ctx context.Context) ([]UserWatchlist, error) {
	rows, err := a.Repo.ListWatchListsForPushSubscribers(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]UserWatchlist, len(rows))
	for i, r := range rows {
		out[i] = UserWatchlist{UserID: r.UserID, Symbols: r.Symbols}
	}
	return out, nil
}
