# Vendor comparison data

One JSON file per vendor, used by the public "ReadAloud vs X", "X alternatives" and "Migrate from X to ReadAloud" pages. This directory is public: no private data, costs, margins or secrets belong here.

## Rules

- Every fact comes from a public page that was actually read; the page URL and retrieval date (`retrievedAt`, ISO date) are recorded.
- Unknown values are `null` (or `"unknown"` for enum fields) and listed in `unknowns`. Nothing is guessed.
- Prices are USD per one million characters where the vendor bills per character. Other units (per token, per minute, credits, subscriptions) are recorded in `tiers[].unit` with `pricePer1MCharsUsd: null`.
- Every price that matters was read from the primary page and checked against a second page of the same vendor, or the `unknowns` list states it is single-source.
- Latency and quality figures are `vendor-stated`, labelled as such, and never benchmarked by us.
- Compliance fields are `"stated"` only if the vendor's own page says so (self-attested); otherwise `"not-stated"`, which means "not found on pages read", not "absent".
- Quotes are at most 125 characters and shown in quotation marks.
- Tone is fair and positive about the vendor: acknowledge real strengths, state limitations only as facts from the vendor's own pages. No ReadAloud claims in these files.
- Gated content is not used. No more than a few fetches per vendor.

## Schema

```
{
  slug, name, url,
  status: "active" | "unclear" | "inactive",
  retrievedAt,                       // "YYYY-MM-DD"
  category: "api-platform" | "cloud-provider" | "studio-tool" | "model-vendor" | "open-source-host",
  positioning,                       // one neutral sentence
  pricing: {
    model, headline,
    pricePer1MCharsUsd,              // number | null; entry/standard tier a developer would call
    headlineTier,                    // which tier the headline number is
    tiers: [{ name, pricePer1MCharsUsd, unit, notes }],
    freeTier,                        // string | null
    promotions,                      // string[] with end dates
    sourceUrls
  },
  voices: { count, languages, customVoiceOrCloning, sourceUrl },
  streaming: { websocket, http, vendorStatedLatency, sourceUrl },  // "yes" | "no" | "unknown"
  formats,                           // string[]
  ssml,                              // "yes" | "no" | "unknown"
  compatibility: { openaiSpeechCompatible, note },
  licensing: { commercialUse, attributionOrConditions, sourceUrl },
  limits: { perRequestCharacters, concurrency, sourceUrl },
  sdks,                              // string[]
  compliance: { hipaa, soc2, gdpr, note, sourceUrl },  // "stated" | "not-stated"
  strengths: [{ claim, sourceUrl }],     // 3 to 5
  limitations: [{ claim, sourceUrl }],   // 0 to 3
  migration: { stepsToMove, sourceUrls },
  bestFor,
  sources: [{ url, title, retrievedAt }],
  unknowns
}
```
