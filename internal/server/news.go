package server

import (
	"context"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/url"

	"github.com/teckdroids/ges-data-engine/internal/analysis"
)

// googleNewsSource implements analysis.NewsSource by scraping the Google News
// RSS feed. It is intentionally tiny — the analysis package owns sentiment
// scoring; this adapter just fetches and decodes XML.
type googleNewsSource struct {
	httpClient *http.Client
}

func (g *googleNewsSource) FetchHeadlines(ctx context.Context, symbol string) []analysis.Headline {
	q := url.QueryEscape(fmt.Sprintf("%s stock Ghana", symbol))
	rssURL := fmt.Sprintf("https://news.google.com/rss/search?q=%s&hl=en-GH&gl=GH&ceid=GH:en", q)

	req, err := http.NewRequestWithContext(ctx, "GET", rssURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Oracle Agent 1.0)")

	resp, err := g.httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	var feed struct {
		Items []struct {
			Title string `xml:"title"`
		} `xml:"channel>item"`
	}
	if err := xml.NewDecoder(resp.Body).Decode(&feed); err != nil {
		return nil
	}

	out := make([]analysis.Headline, 0, len(feed.Items))
	for _, it := range feed.Items {
		out = append(out, analysis.Headline{Title: it.Title})
	}
	return out
}
