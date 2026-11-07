# World & Markets Brief

A self-updating page of filtered world and financial headlines. About every 15 minutes, a GitHub Actions job collects approved feeds, filters them and republishes this static site to GitHub Pages. There is no server or database.

## Run it locally

```bash
node --test scripts/
node scripts/build-feed.mjs
```

The second command writes `site/data/feed.json`. Serve the `site` folder with any static file server to view the page.

## Change what appears

- **Sources and market data:** edit `SOURCES` and `MARKETS` in `scripts/build-feed.mjs`.
- **Filter rules:** edit `BLOCKED_PATHS` and `BLOCKED_TITLES` in `scripts/feed-lib.mjs`.

Before adding a source, check that its feed dates are reliable and that its terms allow this use.

## Data use

- The page shows headlines and links only, credited to each source.
- Keep it non-commercial: some sources, including NPR, limit how their feeds can be used.
- S&P 500, Dow and Nasdaq data are left out because FRED marks S&P and Nasdaq data as needing prior permission.
- This is general information, not financial advice.
