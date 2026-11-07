# KidsStar for Yuvomi – Kids & Stars

A [Yuvomi](https://github.com/FlessingLabs/yuvomi) module in which children earn stars for everyday actions and redeem them in a star shop:

**do an action → parents confirm (optional) → earn stars → save for a wish → redeem in the star shop → parents hand over the gift.**

* Actions with symbol, stars, weekdays, times per day, once or repeating, with or without approval; six editable templates.
* Per-child balance and history (available, reserved, every booking with reason and time). Bonus stars and visible corrections; never a negative balance, no penalties.
* Star shop with pictures, price, availability and per-child visibility; children's wishes priced or declined by parents; savings goal ("You have 24 of 40 stars. 16 more to go.").
* Redeeming reserves the stars atomically; parents approve or decline and mark the gift as handed over. Price and title are snapshotted.
* **Hallway tablet "Who are you?"** for children who cannot read yet: picture tiles, optional four-symbol picture code, profile switch and idle timeout, with its own KidsStar-only device pairing (no Yuvomi login on the tablet).
* Uses Yuvomi's login, family roles, permissions (`ext:kidsstar`), page layout, light/dark mode, German and English, dashboard tile. Self-hosted, no tracking, no cloud, no CDN.

Two parts: `module/` (installed into Yuvomi) and `sidecar/` (a small service with its own SQLite database, running beside Yuvomi). **Yuvomi's module installer installs only `module/`; it does not deploy the service.** Yuvomi itself stays unchanged.

Documentation (German): [docs/BETRIEB.md](docs/BETRIEB.md) – setup, reverse proxy, activation, updates, hallway tablet, backup and restore · [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) – architecture, and why KidsStar keeps its own ledger instead of Yuvomi's rewards · [docs/TESTS.md](docs/TESTS.md) – what was tested and known limitations.

Tested with **Yuvomi 2.86.0**. `npm test` runs 75 tests without dependencies; `tools/e2e/run.sh` runs an acceptance pass against a real Yuvomi.

License: MIT
