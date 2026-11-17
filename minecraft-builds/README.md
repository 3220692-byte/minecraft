# Build Archive

A Minecraft build journal: screenshots, coordinates, biomes, block lists and
notes for every build — published as a completely static site on **GitHub
Pages**. No server, no build step, no dependencies.

![stack](https://img.shields.io/badge/static-HTML%20%2F%20CSS%20%2F%20JS-7ed957?style=flat-square)
![host](https://img.shields.io/badge/host-GitHub%20Pages-4fd6d6?style=flat-square)

---

## What it does

- **Build cards** with cover screenshot, category, coordinates, biome and blocks.
- **Photo uploader** with drag & drop, thumbnails and a cover image. Images are
  resized in the browser (1600 px + 720 px thumbnails, JPEG) before storage, so
  pages stay fast.
- **Detail view** with a gallery, lightbox and full notes.
- **Search, category filters and sorting** across the whole archive.
- **Local-first storage** in IndexedDB — nothing leaves the device until you
  publish.
- **Publish to GitHub** from inside the app: new screenshots are committed to
  `photos/`, and the archive index is written to `data/builds.json`.
- **Export / import JSON** backups, including embedded images.

The visual design is deliberately Minecraft-flavoured: deepslate panels, beveled
buttons, pixel type for headings, and procedurally generated pixel placeholders
for builds that have no screenshots yet.

---

## Quick look locally

Just open `index.html` in a browser. Everything works offline except the Google
Fonts (it falls back to a system font) and publishing.

Prefer a real local server? From this folder:

```powershell
python -m http.server 8080
```

Then visit <http://localhost:8080>. (The repository root also has a PowerShell
static server, `serve.ps1`, if you prefer.)

---

## Put it on GitHub Pages

1. Create a **public** repository on GitHub, e.g. `minecraft-builds`.
2. Upload everything in this folder to the repository root:
   `index.html`, `styles.css`, `app.js`, `config.js`, `data/`, and this README.
   (GitHub → **Add file → Upload files** → drag the files → commit.)
3. In the repository, go to **Settings → Pages**.
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)**
   - Save.
4. Wait a minute. Your archive is live at
   `https://YOURNAME.github.io/minecraft-builds/`.

> If you rename the repository, update the project URL in your browser — the
> site works from any path, no configuration needed.

---

## Turn on publishing (optional but recommended)

Without this step the site is a **read-only published archive**: visitors see
whatever is in `data/builds.json`, but new builds you add exist only in your
browser.

1. Open <https://github.com/settings/personal-access-tokens/new>.
2. Give it a name, choose an expiration, and set **Repository access** to
   *Only select repositories* → your archive repository.
3. Under **Permissions → Repository permissions**, set **Contents** to
   **Read and write**. Nothing else is needed.
4. Generate the token and copy it.
5. Open the site, click **Publish → Publishing setup**, enter:
   - Repository: `YOURNAME/minecraft-builds`
   - Branch: `main`
   - Token: the token you copied
6. **Save & test**, then add/edit builds and hit **Publish to GitHub**.

The token is stored in `localStorage` in **this browser only**. It is never
written into the repository or sent anywhere except `api.github.com`. Use a
fine-grained token limited to this one repository, and revoke it if you ever
share the computer.

You can also hard-code the repository (not the token) in `config.js`:

```js
window.BUILD_ARCHIVE_CONFIG = {
  REPO: "yourname/minecraft-builds",
  BRANCH: "main",
  DATA_PATH: "data/builds.json",
  PHOTO_DIR: "photos"
};
```

---

## How the files fit together

```
minecraft-builds/
├─ index.html          the whole interface (dialogs, forms, sections)
├─ styles.css          the Minecraft-inspired design system
├─ app.js              storage, image resizing, GitHub publishing, UI logic
├─ config.js           optional repository defaults
├─ data/
│  └─ builds.json      published archive index (written by the app)
└─ photos/
   └─ <build-id>/      screenshots + thumbnails (written by the app)
      ├─ <photo-id>.jpg
      └─ <photo-id>-thumb.jpg
```

`data/builds.json` looks like this:

```json
{
  "version": 1,
  "published": true,
  "updatedAt": "2026-11-17T10:00:00.000Z",
  "builds": [
    {
      "id": "…",
      "name": "The Copper Lighthouse",
      "category": "Survival",
      "coords": "312, 71, -880",
      "biome": "Stony shore",
      "world": "Survival · season 4",
      "blocks": ["Copper", "Deepslate bricks"],
      "description": "…",
      "photos": [
        {
          "id": "…",
          "file": "photos/<build-id>/<photo-id>.jpg",
          "thumb": "photos/<build-id>/<photo-id>-thumb.jpg",
          "w": 1600,
          "h": 900
        }
      ],
      "createdAt": "2026-11-15T10:00:00.000Z",
      "updatedAt": "2026-11-15T10:00:00.000Z"
    }
  ]
}
```

Photo paths are relative, so the gallery works on GitHub Pages project sites,
user sites, or a custom domain. The `published` flag is `false` in the copy that
ships with the site (so a fresh install shows the sample builds) and becomes
`true` the first time you publish.

---

## Day-to-day workflow

1. Build something. Take screenshots (F2 in Minecraft).
2. Click **New build**, fill in the details, drag in the screenshots.
3. **Save build** — it is stored locally straight away.
4. Repeat until the archive is up to date.
5. Click **Publish to GitHub** once. Only new images are uploaded; the index is
   rewritten in one commit.
6. Wait ~1 minute for GitHub Pages to rebuild.

If you edit on a second computer, use **Export** on the first and **Import** on
the second (or point both at the same repo and publish).

---

## Troubleshooting

**"GitHub rejected that token (401)"** — the token was mistyped or expired.
Generate a new fine-grained token with *Contents: Read and write*.

**"Repository not found (404)"** — check `owner/repo`, the branch name, and that
the token lists this repository under *Only select repositories*.

**"Unpublished changes" never goes away** — the publish request failed; open the
browser console or read the toast for the exact GitHub error. Your edits are
still safe in IndexedDB.

**Images show as coloured blocks** — that is the placeholder for builds without
screenshots. If a published screenshot is missing, the card automatically retries
against `raw.githubusercontent.com`.

**The site is blank on GitHub Pages** — confirm Pages is set to the branch and
`/ (root)` folder, and that `index.html` sits at the repository root.

**Fonts look plain** — Google Fonts could not load; the layout still works with
the system monospace fallback.

---

## Notes

- Sample builds appear on first run so the layout is not empty. Remove them with
  the button above the grid.
- Deleting a build removes it from `builds.json` on the next publish, but the
  image files remain in `photos/`. You can delete those folders by hand if you
  want the repository to stay small.
- Uploading large batches of screenshots can take a moment: each image is a
  separate GitHub commit. Publish in smaller batches if the API rate-limits you.
