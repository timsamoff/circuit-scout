# Circuit Scout — Design Overview

## Overview

Circuit Scout is a database and search tool for DIY guitar effects pedal circuits. It aggregates circuit layouts, schematics, and reference material scraped from blogs, RSS feeds, and static HTML sites in the DIY pedal-building community, and presents the results through a searchable, filterable interface.

The system has two surfaces sharing one backend and one database:

- **Public site** (`index.html`, `js/main.js`, `css/style.css`) — search, filter, favorite, and browse circuits. Supports free-text search, filtering by effect type/difficulty/category/verification status, favoriting (stored in `localStorage`), infinite scroll, and a dark/light theme toggle.
- **Admin dashboard** (`admin.html`, `js/admin.js`, `css/admin.css`) — feed management, manual circuit entry and editing, scraper control, and duplicate cleanup. No authentication is implemented; access control, where it exists, is left to network or deployment-level restrictions rather than the application itself.

## Architecture

### Backend

A single Express server (`server.js`) backs both surfaces. It serves the static frontend files, exposes a REST API, owns the SQLite database (`circuits.db`), and runs the scraping pipeline. There is no separate API service or build step — the server, the scraper, and the static asset host are one process.

### Runtime modes

The public site detects its own environment and switches data sources accordingly, since it runs in two different contexts:

- **Localhost** (`window.location.hostname` is `localhost` or `127.0.0.1`): the frontend calls the live Express API (`/api/circuits`, `/api/filters`, `/api/stats`), which queries SQLite and applies filtering and pagination server-side.
- **GitHub Pages** (any other hostname): no server is available, so the frontend fetches the static `data/circuits.json` snapshot and performs filtering, search, and pagination entirely client-side.

This is why `data/circuits.json` is committed to the repository rather than gitignored — it is the actual data source for the deployed static site, not a build artifact. The admin dashboard has no equivalent static mode; it always talks to the live API, since its purpose is to manage the database that the API and the JSON export are both derived from.

### Data flow

1. **Ingestion.** `scraper.js` and the scraping functions in `server.js` pull circuit data from three source types — RSS/Atom feeds (Blogger and WordPress), XML sitemaps, and static HTML listing pages (parsed with Cheerio) — and normalize each into a common circuit record shape: name, type, difficulty, tags, description, image, category, and verified flag.
2. **Storage.** Normalized records are inserted into a `circuits` table in SQLite, deduplicated by URL. `http://` and `https://` variants of the same URL are treated as duplicates of each other.
3. **Export.** Every mutation — a scrape, a manual add, edit, or delete, a cleanup run — triggers `autoExportToJSON()` in `server.js`, which re-exports the full `circuits` table to `data/circuits.json`. This keeps the static snapshot in sync with the database after every change, which is what allows the GitHub Pages deployment to stay current without running a server of its own.
4. **Presentation.** The public site reads from either the live API or the static JSON, depending on runtime mode, and renders results as a card grid.

### Content model

A **circuit** is the primary unit of data in the system: a single database row with these fields —

| Field | Notes |
|---|---|
| `url` | Unique; used as the deduplication key |
| `effect_name` | Display name |
| `type` | Effect type — Fuzz, Overdrive, Delay, etc. |
| `parts_count` | Optional |
| `difficulty` | Beginner, Intermediate, Advanced, or Expert |
| `tags` | JSON array |
| `image_url` | |
| `components` | JSON object |
| `description` | |
| `verified` | Boolean |
| `ignored` | Boolean — excludes the circuit from public results and future scrapes without deleting it |
| `category` | `circuit`, `reference`, `guide`, or `wiring`; the public UI collapses the latter three into a single "Reference" badge |

A **scraper source** is the secondary unit: one registered feed or site the scraper pulls from. These live in the `rss_feeds` table despite the name, which also holds static-HTML and sitemap sources via a `source_type` column. Each source tracks `last_scraped` to support incremental re-scraping — a feed scraped within the configured age window is skipped on the next run.

### Detection heuristics

Circuit metadata that isn't explicit in the source — effect type, difficulty, category, verified status — is inferred from title and description text using keyword matching: a fixed list of effect-type names, reference-vs-circuit title patterns (containing "guide," "tutorial," "wiring," and similar), and verification signals (title or category containing "verified" or "confirmed").

This detection logic is implemented independently in four places: three functions in `server.js` and one set of functions in `scraper.js`, each with a slightly different effect-type vocabulary. A fix or an addition made in one location does not propagate to the others.

### Design tokens

The two stylesheets maintain separate token systems rather than sharing one:

- `css/style.css` defines a complete light/dark theme through CSS custom properties — a `:root` block holding dark-mode defaults, overridden by a `body.light-mode` block — covering spacing, font sizes, radii, colors, shadows, and transitions.
- `css/admin.css` defines a separate, single-mode (dark-only) token set with different variable names, no light mode, and largely untokenized `rem`/`px` values outside its own small set of custom properties.

The admin dashboard has no theme toggle and does not consume the public site's token vocabulary, even where the visual result — surface colors, card shapes, accent hues — is clearly meant to echo it.

## Known structural gaps

- **Duplicated scraping and parsing logic.** `server.js` contains its own copies of feed-entry processing, effect-type detection, and HTML-entity decoding that substantially overlap with logic in `scraper.js`. `scraper.js`'s exported `runScraper` and `scrapeSingleFeed` functions ignore their `feedId` and `db` arguments and unconditionally re-run the full scrape across every enabled feed. Whether these exports are still an active code path, or a leftover from an earlier structure, is not evidenced in the code itself — `server.js` scrapes feeds through its own inline implementation and only imports `scrapeStaticListing` from `scraper.js`.
- **Standalone maintenance scripts.** `fix-duplicates.js`, `fix-titles.js`, `fix-descriptions.js`, and `force-export.js` each reimplement a piece of logic that also exists in `server.js` — duplicate removal, HTML-entity decoding, JSON export — rather than calling into a shared function. Each reads as having been written to solve one specific past data problem rather than as a permanent part of the toolset.
- **Two independently maintained design-token sets**, described above, rather than one shared source consumed by both surfaces.

These are described as the current state of the system, not as defects requiring correction on any particular timeline.
