# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-18

First standalone release, split out of KiwiAPI.

### Added

- View mode: open a folder or files, filter the list, and see each blueprint with the game's shading, backdrops, a sun control and PNG snapshots.
- Edit mode: the Blueprint Editor, with painting, materials, add, erase, box fill, selection, slicing, transforms, layers and union, the Creations check, `.qb` export and import, and autosave in the browser.
- The blueprint decoder, encoder and every editing operation run in the browser; checked against the reference implementation on Trove's full set of blueprints.
- Optional specular map from the user's own game files.
- A demo lantern model.
