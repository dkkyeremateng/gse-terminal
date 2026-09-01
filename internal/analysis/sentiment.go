package analysis

import (
	"math"
	"regexp"
	"strings"
)

// Headline is the minimal news shape weightedSentiment needs. Defining it here
// (rather than importing from server) keeps the analysis package free of HTTP
// dependencies.
type Headline struct {
	Title string
}

type sentimentKeyword struct {
	re     *regexp.Regexp
	weight float64
}

func buildKW(word string, weight float64) sentimentKeyword {
	return sentimentKeyword{re: regexp.MustCompile(`\b` + word + `\b`), weight: weight}
}

var (
	bullishKWs = []sentimentKeyword{
		buildKW("profit", 0.3), buildKW("dividend", 0.3), buildKW("bonus", 0.25),
		buildKW("growth", 0.2), buildKW("gain", 0.2), buildKW("surge", 0.25),
		buildKW("expand", 0.2), buildKW("record", 0.2), buildKW("upgrade", 0.25),
		buildKW("outperform", 0.3), buildKW("beat", 0.2), buildKW("rally", 0.25),
	}
	bearishKWs = []sentimentKeyword{
		buildKW("loss", 0.3), buildKW("decline", 0.25), buildKW("drop", 0.2),
		buildKW("fall", 0.2), buildKW("debt", 0.2), buildKW("scam", 0.4),
		buildKW("scandal", 0.4), buildKW("fraud", 0.4), buildKW("default", 0.35),
		buildKW("downgrade", 0.3), buildKW("underperform", 0.3), buildKW("miss", 0.2),
		buildKW("warning", 0.25),
	}
)

// WeightedSentiment scores headlines with recency decay (newest = weight 1.0,
// each older item gets multiplied by 0.85) and word-boundary keyword matching.
// Result is clamped to [-1.0, +1.0].
func WeightedSentiment(items []Headline) float64 {
	totalScore, totalWeight := 0.0, 0.0
	for i, item := range items {
		itemWeight := math.Pow(0.85, float64(i))
		score := 0.0
		t := strings.ToLower(item.Title)
		for _, kw := range bullishKWs {
			if kw.re.MatchString(t) {
				score += kw.weight
			}
		}
		for _, kw := range bearishKWs {
			if kw.re.MatchString(t) {
				score -= kw.weight
			}
		}
		score = math.Max(-1.0, math.Min(1.0, score))
		totalScore += score * itemWeight
		totalWeight += itemWeight
	}
	if totalWeight == 0 {
		return 0
	}
	return math.Max(-1.0, math.Min(1.0, totalScore/totalWeight))
}

// SimpleSentiment is a coarse single-headline classifier kept for the news
// feed badge endpoints. It returns +0.2 per bullish keyword and −0.2 per
// bearish keyword (clamped to ±1).
func SimpleSentiment(title string) float64 {
	bullish := []string{"gain", "growth", "profit", "surge", "higher", "dividend", "bonus", "expand", "record", "strong", "upgrade", "rally"}
	bearish := []string{"loss", "drop", "fall", "decline", "lower", "risk", "debt", "scam", "scandal", "fraud", "default", "downgrade", "warning"}

	score := 0.0
	lower := strings.ToLower(title)
	for _, w := range bullish {
		if strings.Contains(lower, w) {
			score += 0.2
		}
	}
	for _, w := range bearish {
		if strings.Contains(lower, w) {
			score -= 0.2
		}
	}
	return math.Max(-1.0, math.Min(1.0, score))
}
