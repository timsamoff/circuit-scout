# Circuit Scout — Design Overview

This document is reverse-engineered from the current codebase, not a forward-looking design document written in advance. It describes what the system does and how its parts fit together, inferred by reading the code as it exists today. Where the reasoning behind a decision isn't recoverable from the code itself, that's noted explicitly rather than guessed at. Tradeoffs and rejected alternatives that may have existed in the original author's head are not represented here — only what the current implementation reveals about its own structure.

## What this is

Circuit Scout is a database and search tool for DIY guitar effects pedal circuits. It aggregates circuit layouts, schematics, and reference material scraped from blogs, RSS feeds, and static HTML sites in the DIY pedal-building community, and presents them through a searchable, filterable public interface.

## Surfaces

Two HTML entry points share one backend and one data layer:

- **Public site** (`index.html` / `js/main.js` / `css/style.css`) — the search and browse interface end users see. Supports free-text search, filtering by effect type/difficulty/category/verification status, favoriting (stored in `localStorage`), infinite scroll, and a dark/light theme toggle.
- **Admin dashboard** (`admin.html` / `js/admin.js` / `css/admin.css`) — feed management, manual circuit entry/editing, scraper control, and duplicate cleanup. No authentication is implemented; access control (if any) is left to network/deployment-level restrictions such as not exposing `/admin` publicly.

## Runtime modes

The public site (`js/main.js`) detects its own environment and switches data sources accordingly:

- **Localhost** (`window.location.hostname` is `localhost`/`127.0.0.1`): fetches from the live Express API (`/api/circuits`, `/api/filters`, `/api/stats`), which queries SQLite directly and applies filters server-side.
- **Anything else (GitHub Pages deployment)**: fetches the static `data/circuits.json` snapshot and does all filtering, search, and pagination client-side in the browser.

This dual-mode design is why `data/circuits.json` is deliberately *not* gitignored (per the `.gitignore` comment) — it is the actual data source for the deployed static site, not just a build artifact.

The admin dashboard (`js/admin.js`) has no static-mode equivalent; it always talks to the live API, since it exists to manage the database that the API and JSON export are both derived from.

## Data flow

1. **Ingestion**: `scraper.js` and the scraping functions embedded in `server.js` pull circuit data from three source kinds — RSS/Atom feeds (Blogger, WordPress), XML sitemaps, and static HTML listing pages (via Cheerio) — and normalize each into a common circuit record shape (name, type, difficulty, tags, description, image, category, verified flag).
2. **Storage**: normalized records are inserted into a `circuits` table in `circuits.db` (SQLite), deduplicated by URL (with `http://`/`https://` variants treated as the same URL).
3. **Export**: every mutation (scrape, manual add/edit/delete, cleanup) triggers `autoExportToJSON()` in `server.js`, which re-exports the entire `circuits` table to `data/circuits.json`. This keeps the static JSON snapshot in sync with the database after every change, which is what lets the GitHub Pages deployment stay current without running a server.
4. **Presentation**: the public site reads either the live API or the static JSON (per the runtime-mode detection above) and renders results as a card grid.

## Content model

A **circuit** (the recurring unit of work in this project) is a single row with these fields: `url` (unique), `effect_name`, `type` (effect type, e.g. Fuzz/Overdrive/Delay), `parts_count`, `difficulty` (Beginner/Intermediate/Advanced/Expert), `tags` (JSON array), `image_url`, `components` (JSON object), `description`, `verified` (boolean), `ignored` (boolean — excludes the circuit from public results and future scrapes without deleting it), and `category` (`circuit`, `reference`, `guide`, or `wiring` — the public UI collapses the latter three into a "Reference" badge, treating only `circuit` as content-type "Circuit").

A secondary unit, a **scraper source** (`rss_feeds` table despite the name — it also holds static HTML and sitemap sources via a `source_type` column), represents one registered feed/site the scraper pulls from, tracked by `last_scraped` to support incremental re-scraping.

## Detection heuristics

Circuit metadata that isn't explicitly present in the source (effect type, difficulty, category, verified status) is inferred from title/description text using keyword matching — a fixed list of effect-type names (Fuzz, Overdrive, Distortion, etc.), reference-vs-circuit patterns (title containing "guide," "tutorial," "wiring," etc.), and verification signals (title or category containing "verified" or "confirmed"). This logic is implemented independently in at least four places across `server.js` and `scraper.js` (see the audit report's Part 1 findings) rather than being centralized — a structural fact worth knowing before changing detection behavior, since a fix applied in one copy will not propagate to the others.

## Design/token system

Both stylesheets define their own `:root` custom-property block rather than sharing one token file:

- `css/style.css` defines a full light/dark theme (`:root` = dark defaults, `body.light-mode` overrides) with a fairly complete scale: spacing, font sizes, radii, colors, shadows, transitions.
- `css/admin.css` defines a separate, single-mode (dark-only) token set with different variable names, no light mode, and mostly ad-hoc `rem`/`px` values outside its own tokens rather than reusing `style.css`'s scale.

The two files were evidently built somewhat independently — the admin dashboard has no theme toggle and does not share the public site's design-token vocabulary, even where the visual result (colors, card shapes) is meant to look related. See the audit report for specifics.

## Known architectural rough edges

This section states plainly what the codebase's own structure reveals as unresolved, rather than presenting it as deliberate:

- **Duplicated scraping/parsing logic.** `server.js` contains its own copies of feed-entry processing, effect-type detection, and HTML-entity decoding that substantially duplicate logic also present in `scraper.js`, which is itself only partially wired up (`runScraper`/`scrapeSingleFeed` in `scraper.js` ignore their `feedId`/`db` arguments and just re-run `scrapeAllFeeds()` against all enabled feeds). It is not clear from the code alone whether `scraper.js`'s exported functions are still an active code path from `server.js`'s perspective, or legacy from an earlier structure — `server.js` scrapes feeds itself and only imports `scrapeStaticListing` from `scraper.js`.
- **One-off maintenance scripts overlapping server logic.** `fix-duplicates.js`, `fix-titles.js`, `fix-descriptions.js`, and `force-export.js` each reimplement a piece of logic that already exists in `server.js` (duplicate removal, HTML entity decoding, JSON export) rather than calling into shared functions. Each was apparently written to solve one specific past data problem rather than as a permanent part of the toolset.
- **Two independently maintained design-token sets** (see above), rather than one shared source consumed by both surfaces.

None of this is presented as something that must be fixed — only as what the code currently shows, so a future change doesn't mistake duplication for an intentional pattern.
