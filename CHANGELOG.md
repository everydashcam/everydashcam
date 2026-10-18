# Changelog

<!-- Generated from src/changelog/entries.ts by scripts/generate-changelog-md.mjs.
     Do not edit by hand - edit the entries and regenerate: npm run generate:changelog -->

User-facing changes, newest first. Dates are when the change landed on
[beta](https://beta.everydashcam.app); production picks it up with the next
release tag. Localized texts ship inside the app (the "What's new" panel).

## 2026-10-18

- **Fixed:** Fixed incorrect speed readings in some TS recordings.
- **Fixed:** Fixed route jumps and inflated distances in trips with multiple cameras.
- **Fixed:** Fixed a bug that could leave saved clip boundaries unblurred.
- **Fixed:** Fixed a bug that could split front and rear recordings into separate trips.

## 2026-10-15

- **Improved:** Improved face and license plate detection.

## 2026-10-11

- **Improved:** Improved support for TS recordings.

## 2026-10-09

- **Improved:** Migration from dashcamigo to everydashcam.
- **Improved:** dashcamigo has moved to everydashcam.app; restore your notes in Settings.
- **New:** Prepare your notes for the move to everydashcam.app in Settings.

## 2026-10-07

- **Improved:** Full-screen video can stay above the controls.
- **New:** Missing speed readings are estimated from coordinates.
- **New camera support:** INNOVV K3.

## 2026-10-05

- **Improved:** Dependency updates.
- **New:** Automatic encoder selection with a choice of mode in Settings.
- **Improved:** Diagnostic reports include more GPU details.
- **New camera support:** RedTiger F17.

## 2026-10-04

- **Improved:** Dependency updates.

## 2026-09-29

- **Improved:** Dependency updates.

## 2026-09-28

- **Improved:** Vueroid S1 4K Infinite support.

## 2026-09-27

- **New camera support:** Added support for INNOVV N2.
- **Fixed:** Minor fixes.

## 2026-09-25

- **New:** Added an experimental offline mode.
- **Improved:** Minor fixes and dependency updates.

## 2026-09-20

- **Fixed:** A clip’s GPS alignment no longer shifts when other recordings have different clocks.

## 2026-09-19

- **New:** Backward and forward seek buttons repeat while held.
- **New:** Maps mark trip endpoints and indicate missing GPS positions.
- **New camera support:** Avylet A1 recordings with GPS show routes and speed.
- **Fixed:** Raster maps no longer appear blurry on high-resolution screens.
- **Fixed:** Speed-colored routes no longer blend into roads.

## 2026-09-18

- **Fixed:** Canceling an export no longer reports a save error.
- **Improved:** Raster maps remain north-up and flat, including in exports.
- **New:** Choose the map's appearance and provider, including Yandex where available.
- **New:** Reflect each camera horizontally or vertically during playback and export.
- **Fixed:** DDPAI Z60 Pro previews no longer appear as duplicate recordings.
- **Fixed:** Some MP4 recordings that failed to export can be saved.

## 2026-09-17

- **Fixed:** Recordings from some multi-camera devices no longer split into separate trips.

## 2026-09-16

- **Fixed:** Some TS recordings no longer fail to open.
- **New camera support:** XEGA recordings show both cameras, route, and speed.
- **New:** Trips can be filtered by recording mode, notes, or favorites.

## 2026-09-14

- **Fixed:** Seeking no longer stalls in rare cases.
- **New camera support:** Blackview X5S PRO recordings are supported.
- **New camera support:** Front/rear cameras and recording modes are recognized for iBOX RoadScan 2K.

## 2026-09-13

- **Improved:** Export is faster.
- **New camera support:** Route and speed are available for iBOX RoadScan 2K recordings.

## 2026-09-08

- **New camera support:** Recordings from 70mai interior cameras are supported.

## 2026-09-07

- **Improved:** The viewer offers help with missing GPS or cameras.
- **Fixed:** Full-screen preview opens while editing a clip.

## 2026-09-06

- **Fixed:** Exports retain GPS data from tracks with many points.
- **Improved:** Playback controls can stay visible in full screen.
- **Fixed:** Playback can be retried after errors or continue without unsupported audio.
- **Fixed:** Recordings open even if extra GPS data cannot be read.
- **Fixed:** Export continues when audio is unsupported or GPS cannot be added.
- **Improved:** Blurring selected areas in exported videos.

## 2026-09-05

- **Improved:** Updated the interface and simplified common actions.
- **New camera support:** Added GPS track and speed for iZEEKER iD300 recordings.

## 2026-09-03

- **Improved:** Export overlay settings persist between visits and can be reset.

## 2026-09-01

- **Improved:** A notes file in the opened recording folder takes priority; otherwise dashcamigo uses the last-used file.
- **Improved:** On the first change to trip notes, favorites, or markers, you can now choose browser storage or a notes file.
- **Fixed:** Looping and replay work for single-clip trips.
- **Fixed:** Playback no longer stalls between clips at higher speeds.
- **New camera support:** Added GPS track and speed for RedTiger F7NP-4K recordings.

## 2026-08-30

- **Improved:** The timeline zoom can now be adjusted with buttons and draggable handles.

## 2026-08-29

- **Improved:** Improved storage and synchronization of trip notes, favorites, and markers.
- **New:** Map markers can now use different vehicles, colors, and sizes.

## 2026-08-28

- **Fixed:** Zoomed charts now show a button to return to the full timeline.
- **New:** GPX tracks can now be previewed before assigning them to trips.

## 2026-08-27

- **Improved:** Improved GPS sync.
- **Fixed:** HEVC recordings no longer show as unsupported when the browser can play them.
- **New camera support:** Recordings from Botslab G300H, JOOYFACT A1, MiVue 955WD Pro, and similar models are now supported.

## 2026-08-26

- **New:** Multiple GPX tracks can now be matched to individual clips.

## 2026-08-24

- **New camera support:** Sony HDR-AS30V recordings now show their GPS track and speed.

## 2026-08-23

- **New:** GPS tracks can now be synced with video separately for each trip.
- **Fixed:** Fullscreen now follows the selected theme.
- **Fixed:** Notes files no longer overwrite changes from other tabs or browser profiles.
- **Improved:** More license plates are now found automatically.

## 2026-08-22

- **Fixed:** Improved blur handling during export.
- **Improved:** Trips now appear before recording checks finish, with progress shown in the list.
- **Fixed:** Renamed 70mai and Juscar recordings now keep their GPS tracks; invalid dates or coordinates are skipped instead of shifting the route.

## 2026-08-21

- **Improved:** The map now switches to a backup source when the primary source is unavailable.

## 2026-08-19

- **Improved:** Localization has been improved.

## 2026-08-18

- **Fixed:** RedTiger and FitCamX two-camera recordings now join the front and rear cameras into one trip instead of two separate ones.
- **New camera support:** Navitel recordings in .TS files now show their GPS track, with correct speed and direction.

## 2026-08-15

- **Fixed:** Picking a whole memory card or drive now shows it as one source with its real name.
- **Improved:** When a video can't be played in your browser (often HEVC on Windows), the player now explains why and shows how to fix it.
- **Fixed:** Fixed false speed spikes on the speed chart for 70mai 4K (A810, M500).
- **New:** Street and place names on the map are now adjustable — a gear right on the map sets the text size and how many street names to show.

## 2026-08-14

- **Fixed:** Fixed playback of some kinds of .ts recordings.
- **New camera support:** Added support for new recording folder and file layouts.

## 2026-08-11

- **Fixed:** Fixed GPS for 70mai 4K cameras (A810, M500): routes were drawn tens of kilometers off to the side — open your folder again and the track lands on the road you actually drove.

## 2026-08-08

- **Fixed:** Right after an update rolls out, the app could get stuck reloading in a loop — now it waits a moment and picks up the new version cleanly.
- **Fixed:** Expanding the map in a narrow window — a foldable or a tablet in portrait — no longer hides the video: the trip list steps aside instead.
- **Improved:** The folder warning on iPhone and iPad now points to the faster ways in — a computer, or copying the files you need into the Files app first.
- **New:** dashcamigo now tells you what's new — the sparkles button up top lights up when something fresh lands.
- **New camera support:** Beferich dashcams are now supported — the GPS track is read straight from the video files.

## 2026-08-07

- **Improved:** On iPhone and iPad, picking a folder now warns that it copies your recordings — and offers picking just the files you need.

## 2026-08-04

- **Improved:** Trip names, notes and markers save to a notes file next to your recordings and load back on their own.
- **New:** Settings now show how much space the recordings cache takes — with a size limit and one-click clearing.
- **New:** Speed, coordinates and GPS status get their own row under the player — hide it from the view menu if you don't need it.
