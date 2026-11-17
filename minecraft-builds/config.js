/* ============================================================
   Build Archive — configuration
   ------------------------------------------------------------
   Fill this in when you want the site to publish to GitHub.
   You can also leave it empty and use the "Publish" button in
   the app: the repository and branch are remembered in this
   browser, and the access token never touches these files.
   ============================================================ */

window.BUILD_ARCHIVE_CONFIG = {
  // "owner/repository" on GitHub, e.g. "seeth/minecraft-builds"
  REPO: "",

  // Branch that GitHub Pages serves from.
  BRANCH: "main",

  // Where the build data is written inside the repository.
  DATA_PATH: "data/builds.json",

  // Folder for uploaded screenshots inside the repository.
  PHOTO_DIR: "photos"
};
