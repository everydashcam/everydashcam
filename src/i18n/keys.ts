// All i18n keys for the project as a union type. Used for strict typing of
// t() and compile-time verification that ru.ts and en.ts contain the same key
// set (via `satisfies Record<I18nKey, string>` in each dictionary).
//
// Conventions:
//  - Dot hierarchy (page.title, sidebar.sort.options.date) groups keys by UI
//    area and reads like a path.
//  - Template strings use ICU MessageFormat syntax; parameters are passed as
//    t(key, {n: 5}). Plurals use {n, plural, one {...} few {...} other {...}}
//    - ICU knows Russian plural rules from CLDR.

export type I18nKey =
    | "settings.export.section"
    | "settings.export.encoder.label"
    | "settings.export.encoder.auto"
    | "settings.export.encoder.hardware"
    | "settings.export.encoder.software"
    | "settings.export.encoder.autoHint"
    | "settings.export.encoder.hardwareHint"
    | "settings.export.encoder.softwareHint"
    | "export.progress.checkingEncoder"
    | "export.notify.softwareEncoder"
    | "export.error.encoderUnavailable"
    // Offline-use choices.
    | "offlineUse.entry"
    | "offlineUse.title"
    | "offlineUse.app.title"
    | "offlineUse.app.description"
    | "offlineUse.app.guide"
    | "offlineUse.app.installed"
    | "offlineUse.app.unavailable"
    | "offlineUse.file.title"
    | "offlineUse.file.description"
    | "offlineUse.file.limits"
    | "offlineUse.file.action"
    | "offlineUse.note"

    // Portable distribution.
    | "portable.loading"
    | "portable.startupUnsupported"
    | "portable.startupFailed"
    | "portable.javascriptRequired"
    | "portable.beta"
    | "portable.beta.description"
    | "portable.open.title"
    | "portable.open.description"
    | "portable.offline.title"
    | "portable.offline.description"
    | "portable.online.title"
    | "portable.map.description"
    | "portable.label"
    | "portable.notice"
    | "portable.fullVersion"
    | "portable.download"
    | "portable.download.description"
    | "portable.update"
    | "portable.map.routeOnly"
    | "portable.blur.explainer"
    | "portable.reset.description"
    | "portable.reset.body"
    | "portable.reset.note"
    | "portable.export.memory"
    | "portable.export.tooLargeForMemory"

    // Page title and meta tags for search engines
    | "page.title"
    | "meta.description"

    // No-JS fallback link text (shown inside <noscript> for crawlers that
    // don't execute JS and for users with JS disabled). Short verb phrase.
    | "noscript.continue"

    // Header
    | "topbar.trips"
    | "topbar.langMenu.label"
    | "topbar.langMenu.title"
    | "topbar.more"
    | "topbar.more.title"
    | "player.camera.settings"
    | "player.camera.flip.horizontal"
    | "player.camera.flip.vertical"
    | "player.camera.flip.hint"
    | "player.more"

    // Sidebar CTA ("add files" button in the sidebar header, shown after
    // the first ingest)
    | "sidebar.cta.label"
    | "sidebar.cta.title"

    // Landing (body.no-trips - empty state before first ingest).
    // Two-column hero: left = copy + drop CTA + capability bullets; right =
    // privacy "safety wall". Sections under hero: works (OS + browser chips),
    // how (3-step strip), faq (sticky title + accordion), foot. The
    // h1/safety/lead values are split into .before / .hl /
    // .after because applyStaticI18n uses textContent (no inline markup) -
    // the orange highlight span sits between siblings in DOM.
    | "landing.hero.h1.before"
    | "landing.hero.h1.hl"
    | "landing.hero.h1.after"
    | "landing.hero.kicker"
    | "landing.hero.allBrands"
    // alts of the hero-column product composite (.landing-hero-shot in
    // index.html): the desktop shot + the phone shot overlapping its corner
    | "landing.hero.shot.alt"
    | "landing.hero.shot.altPhone"
    // docked CTA pill (visible when the drop card scrolls out of view)
    | "landing.dock.hint"
    // open-source line in the safety card
    | "landing.oss.line"
    | "landing.oss.cta"
    | "landing.drop.t1"
    | "landing.drop.t1Touch"
    | "landing.drop.t2"
    | "landing.drop.cta"
    | "landing.drop.freeNote"
    // recent-folder chips + remember flow (persistent-folder mode)
    | "recentFolders.title"
    | "recentFolders.unavailableHint"
    | "recentFolders.forgetLabel"
    | "recentFolders.forgetAll"
    | "recentFolders.permissionHint"
    | "recentFolders.openFailed"
    | "recentFolders.permissionDenied"
    // folder sources: the row per folder the loaded trips came from
    | "folderSources.title"
    | "folderSources.looseFiles"
    | "folderSources.driveRoot"
    | "folderSources.load"
    | "folderSources.loadAria"
    | "folderSources.loadHint"
    | "folderSources.unavailableHint"
    | "folderSources.permissionHint"
    | "folderSources.remember"
    | "folderSources.rememberAria"
    | "folderSources.rememberHint"
    | "folderSources.remembered"
    | "folderSources.rememberedHint"
    | "folderSources.rememberFailed"
    | "folderSources.menu"
    | "folderSources.menuAria"
    // current notes file, selected independently of folder settings
    | "notesFile.title"
    | "notesFile.helpAria"
    | "notesFile.helpBrowser"
    | "notesFile.helpFile"
    | "notesFile.browser"
    | "notesFile.session"
    | "notesFile.ready"
    | "notesFile.connected"
    | "notesFile.problem"
    | "notesFile.create"
    | "notesFile.choose"
    | "notesFile.change"
    // trip annotations: favorite star, name/note editor
    | "sidebar.bucket.favorites"
    | "sidebar.bucket.others"
    | "trip.fav.add"
    | "trip.fav.remove"
    | "trip.editMeta"
    | "tripMeta.title"
    | "tripMeta.nameLabel"
    | "tripMeta.noteLabel"
    | "tripMeta.cancel"
    | "tripMeta.save"
    // timeline markers
    | "player.addMarker"
    | "marker.untitled"
    | "markerModal.title"
    | "markerModal.textLabel"
    | "markerModal.delete"
    | "markerModal.cancel"
    | "markerModal.save"
    | "markerList.title"
    | "markerList.empty"
    | "markerList.seek"
    | "markerList.delete"
    | "markerList.textPlaceholder"
    | "markerList.close"
    // annotations sidecar file
    | "sidecar.fileDescription"
    | "sidecar.enabled"
    | "sidecar.notOurFile"
    | "sidecar.writeFailed"
    | "sidecar.reconnect"
    | "sidecar.partialReadOnly"
    | "sidecar.multipleFound"
    | "sidecar.exportEmpty"
    | "sidecar.exported"
    | "sidecar.importFailed"
    | "sidecar.imported"
    | "annotations.browserSaveFailed"
    // where-annotations-live hint (editor modals) + the one-shot notes-file nudge
    | "annotations.storageHint"
    | "annotations.storageHintFile"
    | "annotations.storageHintReconnect"
    | "annotations.storageHintSession"
    | "annotations.storageHintFileOnly"
    | "annotations.storageAction"
    | "notesStorageModal.title"
    | "notesStorageModal.body"
    | "notesStorageModal.bodySession"
    | "notesStorageModal.browserOnly"
    | "notesStorageModal.sessionOnly"
    | "notesStorageModal.file"
    | "notesStorageModal.error"
    | "landing.caps.a.title"
    | "landing.caps.a.more"
    | "landing.caps.b.title"
    | "landing.caps.b.body"
    | "landing.caps.c.title"
    | "landing.caps.c.body"
    | "landing.caps.e.title"
    // caps.e body is split so two phrases link to the use-case pages
    // (/combine-... and /add-data-overlay-...). data-i18n nodes can hold
    // only plain text (prerender swaps textContent), so the links live as
    // sibling <a> between these text segments - same pattern as hero.lead.
    | "landing.caps.e.body.lead"
    | "landing.caps.e.link.combine"
    | "landing.caps.e.body.mid"
    | "landing.caps.e.link.overlay"
    | "landing.caps.e.body.tail"
    // caps.d is the privacy-blur card (replaced the retired frame-capture
    // card caps.f - frame capture stays in faq.a6 and the JSON-LD featureList).
    // Body is split around a link to /blur-license-plate-in-dashcam-video/,
    // same weave pattern as caps.e above.
    | "landing.caps.d.title"
    | "landing.caps.d.body.lead"
    | "landing.caps.d.link"
    | "landing.caps.d.body.tail"
    | "landing.caps.g.title"
    | "landing.caps.g.body"
    | "landing.safety.eyebrow"
    | "landing.safety.h2.before"
    | "landing.safety.h2.hl"
    | "landing.safety.h2.after"
    | "landing.safety.uploads.title"
    | "landing.safety.uploads.body"
    | "landing.safety.tracking.title"
    | "landing.safety.tracking.body"
    | "landing.safety.offline.title"
    | "landing.safety.offline.body"
    | "landing.works.title"
    | "landing.works.sub"
    | "landing.works.osLabel"
    | "landing.works.browsersLabel"
    | "landing.works.note"
    | "landing.how.s1.num"
    | "landing.how.s1.title"
    | "landing.how.s1.body"
    | "landing.how.s2.num"
    | "landing.how.s2.title"
    | "landing.how.s2.titleTouch"
    | "landing.how.s2.body"
    | "landing.how.s2.bodyTouch"
    | "landing.how.s3.num"
    | "landing.how.s3.title"
    | "landing.how.s3.body"
    | "landing.faq.eyebrow"
    | "landing.faq.h2"
    | "landing.faq.q2"
    | "landing.faq.a2.before"
    | "landing.faq.a2.link"
    | "landing.faq.a2.after"
    | "landing.faq.q4"
    | "landing.faq.a4"
    | "landing.faq.q3"
    | "landing.faq.a3"
    | "landing.faq.q9"
    | "landing.faq.a9"
    | "landing.faq.q6"
    | "landing.faq.a6"
    | "landing.faq.q13"
    | "landing.faq.a13.before"
    | "landing.faq.a13.link"
    | "landing.faq.a13.after"
    | "landing.faq.q12"
    | "landing.faq.a12.before"
    | "landing.faq.a12.link"
    | "landing.faq.a12.after"

    // Ingest results surface through notifications (toast + bell drawer); live
    // progress stays in the relevant overlay instead of duplicating channels.
    | "status.filesNotSelected"
    | "status.duplicatesSkipped"
    | "status.hvccRepaired"
    | "status.audioDamaged"
    | "status.dropReadFailed"
    | "filePicker.busy"
    | "status.nothingLoaded"
    | "status.tripOpenFailed"
    | "status.gpxChooseTrip"
    | "status.gpxAttached"
    | "status.gpsCameraApplied"
    | "gpxAssign.title"
    | "gpxAssign.body"
    | "gpxAssign.tripLabel"
    | "gpxAssign.unassigned"
    | "gpxAssign.alreadyHasGps"
    | "gpxAssign.timeMatches"
    | "gpxAssign.timeMismatch"
    | "gpxAssign.timeUncertain"
    | "gpxAssign.skip"
    | "gpxAssign.apply"
    // Shown when the path filter removes every selected file (system files or
    // preview videos). The user selected files, but no primary recording remains.
    | "status.noRecordingsFound"

    // Offline banner (src/ui/offline-banner.ts): compact label + the info
    // button's accessible name + the detail popover copy.
    | "status.offline.label"
    | "status.offline.info"
    | "status.offline.detail"

    // Notifications: bell button in the topbar, toasts that pop from
    // top-right and the drawer popover that lists session history.
    | "notif.bell.aria"
    | "notif.drawer.title"
    | "notif.drawer.empty"
    | "notif.drawer.clear"
    | "notif.toast.dismiss"

    // Sidebar
    | "sidebar.title"
    | "sidebar.analysis.title"
    | "sidebar.analysis.progress"
    | "sidebar.analysis.hint"
    | "sidebar.filter.kind"
    | "sidebar.filter.options"
    | "sidebar.filter.all"
    | "sidebar.filter.normal"
    | "sidebar.filter.parking"
    | "sidebar.filter.event"
    | "sidebar.filter.manual"
    | "sidebar.filter.notes"
    | "sidebar.filter.eventHint"
    | "sidebar.filter.manualHint"
    | "sidebar.filter.result"
    | "sidebar.filter.reset"
    | "sidebar.filter.empty"
    | "sidebar.sort.label"
    | "sidebar.sort.options.date"
    | "sidebar.sort.options.distance"
    | "sidebar.sort.options.duration"
    | "sidebar.sort.options.size"
    | "sidebar.sort.dir.desc"
    | "sidebar.sort.dir.asc"
    | "sidebar.collapse"
    | "sidebar.expand"
    | "sidebar.resize"
    | "sidebar.unindexed.title"
    | "sidebar.unindexed.note"

    // Expand/collapse chevrons
    | "trip.chevron.expand"
    | "trip.chevron.collapse"

    // Date buckets
    | "buckets.today"
    | "buckets.yesterday"
    | "buckets.thisWeek"
    | "buckets.thisMonth"
    | "buckets.future"
    | "buckets.earlier"

    // Plurals
    | "plurals.trip"
    | "plurals.file"
    | "plurals.camera"
    | "player.nav.video"
    | "player.nav.events"
    | "export.backToTrim"
    | "player.noGps.message"
    | "plurals.pause"

    // Units of measurement
    | "units.kmh"
    | "units.km"
    | "units.mph"
    | "units.mi"

    // GPS readout row under the player bar
    | "readout.gps.ok"
    | "readout.gps.lost"
    | "readout.gps.none"
    | "readout.coords.copy"
    | "readout.copied"
    | "readout.note.aria"
    | "readout.note.tooltip"
    | "units.kb"
    | "units.mb"
    | "units.gb"
    | "units.d"
    | "units.h"
    | "units.m"
    | "units.s"
    | "units.toggle.aria"
    | "units.toggle.title"

    // Trip and file meta
    | "trip.fileMeta.noGps"
    | "trip.chip.noGps"
    // Shown when a clip in the trip could not be read (broken / unreadable file).
    | "trip.chip.readFailed"
    // Trip-level badge on a parking session (parking-mode / time-lapse clips
    // are grouped apart from drives). The road-sign letter "P" in every
    // locale - it reads the same everywhere and the badge slot is narrow; the
    // full word goes into the chip's aria-label (recordingModeLabel).
    | "trip.chip.parking"
    | "trip.fileChip.noGps"
    // Recording-mode chip on a clip whose mode isn't the default loop recording
    // ("normal" gets no chip - see recordingModeLabel in ui/format.ts).
    | "trip.fileChip.mode.event"
    | "trip.fileChip.mode.parking"
    | "trip.fileChip.mode.manual"
    // Time-lapse chip on a sped-up clip, and its tooltip (reused as the player
    // clock's tooltip): the clip is time-compressed, so its on-screen clock and
    // duration do not track real elapsed time.
    | "trip.fileChip.timelapse"
    | "trip.fileChip.timelapseHint"

    // Per-clip technical-details panel (ui/file-details.ts): an opt-in "info"
    // surface where codec/container/bitrate jargon is intentionally allowed
    // (voice.md carve-out 4). "trigger" is the toggle's aria-label; the rest are
    // row labels. timeSource.* label how a clip's start wall-clock was derived
    // (see StartSource in trips.ts).
    | "fileDetails.trigger"
    | "fileDetails.path"
    | "fileDetails.resolution"
    | "fileDetails.frameRate"
    | "fileDetails.video"
    | "fileDetails.audio"
    | "fileDetails.container"
    | "fileDetails.size"
    | "fileDetails.duration"
    | "fileDetails.timeSource"
    | "fileDetails.gps"
    | "fileDetails.timeSource.embedded"
    | "fileDetails.timeSource.mp4"
    | "fileDetails.timeSource.gps"
    | "fileDetails.timeSource.name"
    | "fileDetails.timeSource.mtime"
    | "fileDetails.none.audio"
    | "fileDetails.none.gps"

    // Multi-camera dashcam channels. Full names for tooltip and selector;
    // short names (1 char) for badges next to clip names.
    | "channel.front"
    | "channel.rear"
    | "channel.interior"
    | "channel.side"
    | "channel.front.short"
    | "channel.rear.short"
    | "channel.interior.short"
    | "channel.side.short"
    // Positional label for channels whose mount mapping is a vendor convention
    // we can't verify (CarCam A/B/C/D, Vantrue A/B/C) - shown instead of a
    // semantic "Rear camera". {n} is 1-based position in the trip's channels.
    | "channel.numbered"

    // Empty state
    | "emptyState.first.title"
    | "emptyState.first.step1"
    | "emptyState.first.step2"
    | "emptyState.first.step3"
    | "emptyState.first.hint"
    | "emptyState.withTrips.title"
    | "emptyState.withTrips.hint"
    // Inline "something's off?" affordance under the pick-a-trip placeholder -
    // opens the feedback form (a trip loaded but recognition may be wrong).
    | "emptyState.withTrips.report"

    // Codec unsupported overlay. The three windows* hints are the HEVC-on-Windows
    // branches (Edge needs the Store codec add-on, Chrome is hardware-only) -
    // see codecUnsupportedHintHtml in ui/empty-state.ts; {link} is the Store link.
    | "codecUnsupported.title"
    | "codecUnsupported.hint"
    | "codecUnsupported.hint.windows"
    | "codecUnsupported.hint.windowsChrome"
    | "codecUnsupported.hint.windowsEdge"
    | "codecUnsupported.stillWorks"
    | "playbackFailed.title"
    | "playbackFailed.hint"
    | "playbackFailed.retry"

    // Browser-compatibility surfacing (src/capabilities.ts + ui/capability-gate.ts).
    // - caps.gate.* - the full blocking gate shown when a FATAL Web API is
    //   missing (no Web Workers / <video> / file load). {browser} is the
    //   detected product name (or a generic "your browser").
    // - caps.notice.* - concise proactive toasts for user-visible DEGRADED gaps
    //   (editor / H.264 decode). insecureContext is the editor gap when the real
    //   cause is a plain-http origin (self-hosted LAN, docs/self-hosting.md) -
    //   there "update your browser" would be wrong advice. The "no map" gap is
    //   surfaced separately and lazily (map.unavailable.* below), not here.
    | "caps.gate.title"
    | "caps.gate.body"
    | "caps.gate.advice"
    | "caps.gate.detailsSummary"
    | "caps.notice.editor"
    | "caps.notice.insecureContext"
    | "caps.notice.decode"

    // Unsupported-formats modal: shown before indexing if the drop contains
    // files with extensions we cannot play (.avi/.mts/.wmv/.flv/.3gp/
    // .jdr/.insv/.360/...). User closes it; ingest continues with valid
    // mp4/mov/ts/m2ts/mkv files. The .note string lists supported extensions so
    // the user does not mistakenly assume their .ts files are unsupported too.
    | "unsupported.modal.title"
    | "unsupported.modal.body"
    | "unsupported.modal.entry"
    | "unsupported.modal.note"
    | "unsupported.modal.close"
    // "We couldn't read this card" modal - shown after a zero-trips ingest that
    // still contained recording-like files (the unrecognised-camera case). Its
    // primary CTA routes into the feedback form (which auto-attaches the byte-free
    // folder-structure report); the secondary link opens the public help page.
    | "noRecordings.title"
    | "noRecordings.intro"
    | "noRecordings.help"
    | "noRecordings.howItWorks"
    | "noRecordings.notNow"

    // Deferred-load modal for full embedded-GPS scans. Ordinary video playback
    // continues; event navigation waits because its target depends on telemetry.
    | "gpsLoad.progress"
    | "gpsLoad.pending"
    | "gpsLoad.reading"

    // Per-trip GPS/video calibration. The compact launcher appears beside the
    // readout and in map settings; the detailed controls live in one panel.
    | "gpsSync.open"
    | "gpsSync.badge"
    | "gpsSync.title"
    | "gpsSync.description"
    | "gpsSync.noTrack"
    | "gpsSync.offset.label"
    | "gpsSync.offset.unit"
    | "gpsSync.offset.hint"
    | "gpsSync.earlier"
    | "gpsSync.later"
    | "gpsSync.alignPlayhead"
    | "gpsSync.alignPlayhead.hint"
    | "gpsSync.trim.label"
    | "gpsSync.trim.description"
    | "gpsSync.outside.hidden"
    | "gpsSync.outside.shown"
    | "gpsSync.reset"
    | "gpsSync.applyCamera"
    // Recording-read modal (slow backend): the trip-open path reads the
    // recordings' metadata before playback. Reuses gpsLoad.progress.
    | "recordingLoad.title"
    | "recordingLoad.cancel"

    // Resize separators
    | "resize.videoMap"

    // Mini-map
    | "miniMap.expandAria"
    | "miniMap.close"

    // Map controls
    | "map.follow.group.aria"
    | "map.follow.off"
    | "map.follow.follow"
    | "map.follow.rotate"
    | "map.follow.chase"
    // Chase-mode sub-controls: camera tilt slider + speed-adaptive-zoom toggle.
    | "map.chase.tilt"
    | "map.chase.adaptiveZoom"
    | "map.noGps"
    | "map.tripStart"
    | "map.tripEnd"
    | "map.recenter"
    | "map.collapse"
    // Gear button on the big map opening the map-preferences popover; the
    // popover's label-size row reuses settings.map.labelScale.label.
    | "map.settings"
    | "map.styleError.text"
    | "map.styleError.retry"
    | "map.styleError.dismiss"
    // Map cannot render at all (no WebGL context). Permanent in-panel notice.
    | "map.unavailable.text"
    // Proactive "no map" toasts for the cases where the enable-the-map modal does
    // NOT apply (its desktop steps would be useless): mobile (no such toggle) and
    // an unrecognized browser (the real fix is switching to a mainstream one).
    | "map.unavailable.mobile"
    | "map.unavailable.tryBrowser"
    // "Turn the map on" guide (ui/webgl-enable-modal.ts): shown the first time the
    // map fails to init (when a trip opens), not at startup, and on demand from the
    // in-panel link. The copy NAMES WebGL on purpose - a deliberate voice-rule
    // exception (.claude/rules/voice.md): WebGL is the user's searchable term,
    // matching the browser's settings, chrome://gpu and get.webgl.org. It is paired
    // with the plain fix (hardware acceleration). Two intros: a confident one when
    // we proved the GPU is alive (software renderer / WebGPU), a hedged one otherwise.
    | "webglEnable.title"
    | "webglEnable.intro"
    | "webglEnable.introConfident"
    | "webglEnable.stepsTitle"
    | "webglEnable.chrome"
    | "webglEnable.firefox"
    | "webglEnable.update"
    | "webglEnable.linux"
    | "webglEnable.fallback"
    | "webglEnable.check"
    | "webglEnable.gotIt"
    | "webglEnable.howTo"
    // MapLibre built-in controls (NavigationControl). MapLibre 4 has no public
    // setLocale, so we overwrite title/aria-label on their DOM buttons via
    // querySelector. Keys mirror the default "NavigationControl.*" keys.
    | "map.ctrl.zoomIn"
    | "map.ctrl.zoomOut"
    | "map.ctrl.resetBearing"
    | "map.ctrl.resetBearingFlatOnly"
    | "map.ctrl.attribution"
    | "map.yandex.open"
    // Cooperative-gestures overlay, on wherever the page can scroll past the map
    // (touch, and the stacked layout on any pointer): one finger scrolls the
    // page, two fingers move the map; with a mouse there, plain wheel scrolls
    // and Ctrl/Cmd+wheel zooms. MapLibre picks the Windows or Mac wording by
    // platform, so both variants are localized.
    | "map.coop.twoFingers"
    | "map.coop.ctrlScroll"
    | "map.coop.cmdScroll"

    // Player bar
    | "player.play"
    | "player.pause"
    | "player.playTooltip"
    | "player.pauseTooltip"
    | "player.seekBack"
    | "player.seekFwd"
    | "player.stepBack"
    | "player.stepFwd"
    | "player.mute"
    | "player.unmute"
    | "player.speed.label"
    | "player.speed.title"
    | "player.volume"
    | "player.capture"
    | "player.captureDisabled.noTrip"
    | "player.captureDisabled.codec"
    | "player.loop.off"
    | "player.loop.on"
    | "player.loop.advance"
    | "player.fullscreen.enter"
    | "player.fullscreen.exit"
    | "player.fullscreen.exitShort"
    | "player.fullscreen.expand"
    | "player.fullscreen.restore"
    | "player.fullscreen.hint"
    | "player.fullscreen.error"
    | "player.fullscreen.exitError"
    | "player.controls.pin"
    | "player.view.toggle"
    | "player.view.focus"
    | "player.view.split"
    | "player.export.label"
    | "player.export.tooltip"
    | "player.zoom.minimap.aria"
    | "player.zoom.minimap.title"
    | "player.zoom.reset"
    | "speed.estimated"
    | "player.metrics.placeholder"
    | "player.progress"
    | "player.progress.position"
    | "player.pauseSkipped"
    | "player.tile.cantPlay"

    // Chart
    | "chart.canvas.label"
    | "chart.zoomReset"
    | "chart.zoomOut"
    | "chart.zoomIn"
    | "chart.zoomNavigator"
    | "chart.zoomStatus"
    | "chart.zoomRangeStart"
    | "chart.zoomRangeEnd"
    | "chart.axis.speed"
    | "chart.axis.accel"
    | "chart.pause"
    | "chart.unit.speed"
    | "chart.unit.accel"

    // Inferred event strip (under chart)
    | "chart.inferredStrip.empty"
    | "chart.inferredStrip.kind.stop"
    | "chart.inferredStrip.kind.brake"
    | "chart.inferredStrip.kind.turn"
    | "chart.inferredStrip.kind.accel"
    | "chart.inferredStrip.axis.acc"
    | "chart.inferredStrip.axis.brk"
    | "chart.inferredStrip.estimated"

    // Trip event chip in the sidebar (UX-08)
    | "trip.events.chip.title"

    // Event pop-action (UX-15)
    | "event.popup.titleFmt"
    | "event.popup.action5"
    | "event.popup.action10"
    | "event.popup.action30"
    | "event.popup.export"

    // Events on expanded map (UX-19)

    // Top-panel: composition controls visible above the player. Groups:
    // layout buttons (icons), camera order chips, audio source dropdown,
    // output preset selector (export-mode only). See src/ui/top-panel.ts.
    | "topPanel.layout.label"
    | "topPanel.channels.label"
    | "topPanel.channels.reorderAria"
    | "topPanel.channels.includeAria"
    | "topPanel.audio.label"
    | "export.output.legend"

    // "What's new" changelog panel (entry texts are data in
    // src/changelog/entries.ts - only the panel chrome goes through i18n)
    | "whatsnew.title"
    | "whatsnew.category.support"
    | "whatsnew.category.feature"
    | "whatsnew.category.improvement"
    | "whatsnew.category.fix"
    | "whatsnew.dismissHint"

    // Hotkeys cheatsheet (UX-10)
    | "hotkeys.title"
    | "hotkeys.group.playback"
    | "hotkeys.group.seek"
    | "hotkeys.group.view"
    | "hotkeys.group.export"
    | "hotkeys.group.misc"
    | "hotkeys.action.toggleChart"
    | "hotkeys.action.toggleStrip"
    | "hotkeys.action.toggleMap"
    | "hotkeys.action.toggleReadout"
    | "viewMenu.label"
    | "viewMenu.title"
    | "viewMenu.section.display"
    | "viewMenu.chart"
    | "viewMenu.strip"
    | "viewMenu.map"
    | "viewMenu.map.off"
    | "viewMenu.map.mini"
    | "viewMenu.map.large"
    | "viewMenu.readout"
    | "viewMenu.videoAbovePanels"
    | "viewMenu.videoAbovePanels.description"
    | "hotkeys.action.playPause"
    | "hotkeys.action.mute"
    | "hotkeys.action.fullscreen"
    | "hotkeys.action.speed"
    | "hotkeys.action.seekBack10"
    | "hotkeys.action.seekFwd10"
    | "hotkeys.action.seekFine"
    | "hotkeys.action.seekFineLong"
    | "hotkeys.action.frameStep"
    | "hotkeys.action.seekStart"
    | "hotkeys.action.snapshot"
    | "hotkeys.action.export"
    | "hotkeys.action.setClipEdges"
    | "hotkeys.action.gotoClipEdges"
    | "hotkeys.action.loop"
    | "hotkeys.action.zoomTimeline"
    | "hotkeys.action.zoomReset"
    | "hotkeys.action.help"
    | "hotkeys.dismissHint"
    | "player.help.title"

    // Theme toggle (UX-24)
    | "theme.auto"
    | "theme.light"
    | "theme.dark"
    | "theme.label"

    // Invitations and help for incomplete recognition.
    | "recognition.gps.title"
    | "recognition.gps.body"
    | "recognition.cameras.title"
    | "recognition.cameras.body"
    | "recognition.contact"
    | "recognition.dismiss"
    | "recognition.gps.help"
    | "recognition.cameras.help"
    | "recognition.cameras.hint"
    | "recognition.gps.hint"
    | "recognition.ddpai.gpsFolder"
    | "recognition.files.body"
    | "feedback.step1.preset.gps"
    | "feedback.step1.preset.cameras"
    | "feedback.recognition.intro"
    | "feedback.recognition.samples.title"
    | "feedback.recognition.samples.gps"
    | "feedback.recognition.samples.cameras"
    | "feedback.recognition.mailPrompt"

    // Feedback modal ("report a problem").
    | "feedback.entry.title"
    | "feedback.modal.title"
    | "feedback.thanks"
    // Preset topics - tag the mail subject; set via .feedback-link
    // data-feedback-preset on error entry points (no textarea to prefix anymore).
    | "feedback.step1.preset.load"
    | "feedback.step1.preset.video"
    | "feedback.step1.preset.map"
    | "feedback.step1.preset.chart"
    | "feedback.step1.preset.export"
    | "feedback.step1.preset.other"
    // Step 1 - recordings: real files help most; the user shares a download link
    // (or skips). mailPrompt is the link placeholder dropped into the email body
    // when the user said they have a link. noIngest/loadCta are the callout shown
    // when no card was ever loaded (the report would carry no file layout).
    | "feedback.recordings.title"
    | "feedback.recordings.body"
    | "feedback.recordings.yes"
    | "feedback.recordings.skip"
    | "feedback.recordings.mailPrompt"
    | "feedback.recordings.noIngest"
    | "feedback.recordings.loadCta"
    // Step 2 - report: the "what's inside" disclosure summary + contents, the
    // preview placeholder, and the download button (arrow signals the hand-off).
    | "feedback.step2.what"
    | "feedback.report.contents"
    | "feedback.report.noFilesYet"
    | "feedback.download"
    // Shown when building the feedback report .txt fails.
    | "feedback.error.reportFailed"
    | "feedback.contactDirect"
    | "feedback.cancel"
    // Post-download hand-off: the report is in Downloads (step1 carries the
    // filename), now email it (step2) via the pre-filled mailto (openMail).
    | "feedback.success.step1"
    | "feedback.success.step2"
    | "feedback.success.openMail"
    // Mail composition: subject topic and the plain-text body (the recipient is
    // the FEEDBACK_EMAIL constant in feedback.ts, not an i18n key).
    | "feedback.subject"
    | "feedback.body.attachReminder"
    | "feedback.body.context.title"
    | "feedback.body.context.file"
    | "feedback.body.context.trip"
    | "feedback.body.context.position"
    | "feedback.body.context.codec"
    | "feedback.body.context.fingerprint"
    | "feedback.body.context.layout"
    | "feedback.body.context.zoom"
    | "feedback.body.env.title"
    | "feedback.body.env.app"
    | "feedback.body.env.browser"

    // Track popup
    | "popup.title"
    | "popup.label.speed"
    | "popup.label.gMag"
    | "popup.label.aXYZ"
    | "popup.label.coords"
    | "popup.label.file"
    | "popup.placeholder"
    | "event.brake.label"

    // Upload-warning modal: shown ONCE every 30 days (or on the first visit)
    // before opening the system file picker via CTA buttons. The goal is to
    // reassure the user: the browser will ask "Upload N files?" - that is a
    // generic folder-access prompt; files are not sent anywhere.
    | "uploadWarning.title"
    | "uploadWarning.body"
    | "uploadWarning.continue"
    | "uploadWarning.cancel"
    | "iosFolderWarning.title"
    | "iosFolderWarning.body"
    | "iosFolderWarning.slowMedia"
    | "iosFolderWarning.files"
    | "iosFolderWarning.folder"
    | "iosFolderWarning.cancel"

    // Confirm modal shown when the user changes language while a trip is loaded.
    // Switching language is a full page reload (only the active locale is
    // bundled), which clears loaded recordings - the modal warns before that.
    | "switchLang.title"
    | "switchLang.body"
    | "switchLang.confirm"
    | "switchLang.cancel"

    // Drop overlay
    | "dropOverlay.title"
    | "dropOverlay.hint"
    | "dropOverlay.bullet.folder"
    | "dropOverlay.bullet.pair"
    | "dropOverlay.bullet.multi"

    // Ingest overlay (blocks the UI while processing a folder)
    | "ingestOverlay.title"
    | "ingestOverlay.cancel"
    | "ingestOverlay.queued"
    // Pre-ingest umbrella: shown the instant the user commits to a folder
    // (picker click / folder drop) and held while the browser enumerates the
    // directory - before the real ingest stages below begin.
    | "ingestOverlay.stage.preparing"
    | "ingestOverlay.stage.classifying"
    | "ingestOverlay.stage.parsingLogs"
    | "ingestOverlay.stage.parsingSidecars"
    | "ingestOverlay.stage.canceling"
    // Shown when reading the picked files fails.
    | "ingest.error.loadFailed"

    // Export modal - remaining keys used by top-panel and export-flow.
    | "export.status.preparing"
    | "export.output.source"
    | "export.output.preset.1080_16x9"
    | "export.output.preset.720_16x9"
    | "export.output.preset.1080_9x16"
    | "export.output.preset.720_9x16"
    | "export.output.preset.1080_1x1"
    | "export.output.preset.1080_4x5"
    | "export.output.preset.custom"
    | "export.output.customW"
    | "export.output.customH"
    | "export.split.layout.single"
    | "export.split.layout.h2"
    | "export.split.layout.v2"
    | "export.split.layout.left1right2"
    | "export.split.layout.left2right1"
    | "export.split.layout.grid2x2"
    | "export.split.layout.pip"
    | "export.title"
    | "export.start"
    | "export.download"
    | "export.close"
    | "export.cancel"
    | "export.backToOptions"
    | "export.fallbackWarn"
    | "export.chromiumBanner"
    | "export.chromiumModal.title"
    | "export.chromiumModal.body"
    | "export.quality.legend"
    | "export.quality.original"
    | "export.quality.original.sub"
    | "export.quality.high"
    | "export.quality.high.sub"
    | "export.quality.medium"
    | "export.quality.medium.sub"
    | "export.quality.low"
    | "export.quality.low.sub"
    | "export.quality.size"
    | "export.quality.manual.toggle"
    | "export.quality.manual.label"
    | "export.quality.manual.auto"
    | "export.quality.manual.unit"
    | "export.quality.manual.source"
    | "export.quality.manual.active"
    | "export.estimate.legend"
    | "export.estimate.size"
    | "export.estimate.sizeFloor"
    | "export.estimate.details"
    | "export.estimate.deviceCapped"
    | "export.mode.legend"
    | "export.mode.video"
    | "export.mode.gpx"
    | "export.mode.gpx.sub"
    | "export.gpx.start"
    | "export.gpx.done"
    | "export.gpx.empty"
    | "export.gpx.summary"
    | "export.opt.legend"
    | "export.opt.audio"
    | "export.opt.gpmf"
    | "export.opt.gpx"
    | "export.opt.letterboxBlur"
    | "export.opt.watermark"
    | "export.opt.watermark.plea"
    | "export.overlays.legend"
    | "export.overlays.reset"
    | "export.overlays.speed"
    | "export.overlays.coords"
    | "export.overlays.map"
    | "export.overlays.mapProvider"
    | "export.overlays.mapProvider.yandexUnavailable"
    | "export.overlays.mapScale"
    | "export.overlays.style"
    | "export.overlays.style.min"
    | "export.overlays.style.card"
    | "export.overlays.style.bold"
    | "export.overlays.widgets"
    | "export.overlays.clock"
    | "export.overlays.compass"
    | "export.overlays.gforce"
    | "export.overlays.distance"
    | "export.overlays.graph"
    | "export.overlays.accent"
    | "export.overlays.scrim"
    | "export.overlays.shape"
    | "export.overlays.shape.rect"
    | "export.overlays.shape.circle"
    | "export.overlays.mapTheme"
    | "export.overlays.mapTheme.light"
    | "export.overlays.mapTheme.dark"
    | "export.overlays.mapTheme.neon"
    | "export.overlays.mapMarker"
    | "export.overlays.mapMarker.description"
    // Label size of the burned-in map's street/place names, per export -
    // independent of the viewer's settings.map.labelScale preference.
    | "export.overlays.mapLabelSize"
    // Street-name density of the burned-in map, per export - the preset labels
    // reuse settings.map.streetNames.*, the value is independent of the viewer
    // preference.
    | "export.overlays.mapStreetNames"
    // Map overlay view: north-up vs the tilted heading-up "chase" camera, with a
    // tilt slider and a speed-adaptive-zoom toggle when chase is selected.
    | "export.overlays.mapMode"
    | "export.overlays.mapMode.north"
    | "export.overlays.mapMode.chase"
    | "export.overlays.mapTilt"
    | "export.overlays.mapAdaptive"
    | "export.overlays.size"
    | "export.overlays.dragHint"
    | "export.overlays.watermarkDragHint"
    | "export.overlays.mapDragHint"
    | "export.overlays.resizeMapLabel"
    // Burned-in cardinal letters for the compass dial. Resolved on the main
    // thread and shipped to the worker as data. zh/ja/ko fall back to the
    // English values (the overlay fonts carry no CJK/Hangul glyphs).
    | "export.overlays.compass.n"
    | "export.overlays.compass.e"
    | "export.overlays.compass.s"
    | "export.overlays.compass.w"
    | "export.status.transcoding"
    | "export.status.finalizing"
    | "export.crop.aspect.free"
    | "export.crop.aspect.original"
    | "export.crop.button"
    | "export.crop.done"
    | "export.crop.hint"

    // Privacy blur zones (export panel group + on-tile editor)
    | "export.blur.legend"
    | "export.blur.auto.legend"
    | "export.blur.auto.beta"
    | "export.blur.manual.legend"
    | "export.blur.explainer"
    | "export.blur.add"
    | "export.blur.cancel"
    | "export.blur.regroupChanged"
    | "export.blur.hint"
    | "export.blur.drawHint"
    | "export.blur.editBox"
    | "export.blur.zone"
    | "export.blur.follow"
    | "export.blur.wholeClip"
    | "export.blur.mode.wholeClip"
    | "export.blur.mode.fixed"
    | "export.blur.mode.fixedHint"
    | "export.blur.setStart"
    | "export.blur.setEnd"
    | "export.blur.state.tracked"
    | "export.blur.state.lostCheckEnd"
    | "export.blur.style.label"
    | "export.blur.style.pixelate"
    | "export.blur.style.fill"
    | "export.blur.style.blur"
    | "export.blur.row.jump"
    | "export.blur.row.setStart"
    | "export.blur.row.setEnd"
    | "export.blur.row.delete"
    | "export.blur.row.track"
    | "export.blur.row.trackCancel"
    | "export.blur.track.failed"
    | "export.blur.track.lost"
    | "export.blur.track.followedEnd"
    | "export.blur.track.timeout"
    | "export.blur.tracker.consent"
    | "export.blur.tracker.download"
    | "export.blur.tracker.notNow"
    | "export.blur.tracker.cancel"
    | "export.blur.tracker.progress"
    | "export.blur.tracker.working"
    | "export.blur.tracker.saveBlocked"
    | "export.blur.tracker.offline"
    | "export.blur.tracker.error"
    | "export.blur.tracker.retry"
    | "export.blur.detect.plates"
    | "export.blur.detect.quality.label"
    | "export.blur.detect.quality.fast"
    | "export.blur.detect.quality.balanced"
    | "export.blur.detect.quality.thorough"
    | "export.blur.detect.quality.hint"
    | "export.blur.detect.settings"
    | "export.blur.detect.threshold.face"
    | "export.blur.detect.threshold.plate"
    | "export.blur.detect.threshold.more"
    | "export.blur.detect.threshold.confident"
    | "export.blur.detect.threshold.default"
    | "export.blur.detect.threshold.reset"
    | "export.blur.detect.threshold.hint"
    | "export.blur.detect.faces"
    | "export.blur.detect.hint"
    | "export.blur.detect.review"
    | "export.blur.detect.reviewFindings"
    | "export.blur.detect.needsGpu"
    | "export.blur.detect.consent"
    | "export.blur.detect.download"
    | "export.blur.detect.scanning"
    | "export.blur.detect.countPlates"
    | "export.blur.detect.countFaces"
    | "export.blur.detect.failed"
    | "export.speed.legend"
    | "export.speed.note"
    | "export.speed.result"
    | "export.range.length"
    | "export.range.startLabel"
    | "export.range.endLabel"
    | "export.range.noTrip"
    | "export.range.tabStart"
    | "export.range.tabEnd"
    | "export.range.setStart"
    | "export.range.setEnd"
    | "export.range.reset"
    | "export.range.undo"
    | "export.range.undoTitle"
    | "export.range.zoomToClip"
    | "export.range.zoomToClipTitle"
    | "export.range.fromZoom"
    | "export.range.fromZoomTitle"
    | "export.range.invalidTime"
    | "export.range.minLength"
    | "export.range.resetNote"

    // Export pipeline (export.ts)
    | "export.progress.savingFile"
    | "export.progress.processing"
    | "export.progress.analyzing"
    | "export.progress.writingHeader"
    | "export.progress.embeddingGps"
    | "export.progress.detecting"
    | "export.progress.frames"
    | "export.progress.eta"
    | "export.progress.etaUnknown"
    | "export.progress.bytes"
    | "export.error.generic"
    | "export.error.incompatibleVideo"
    | "export.error.cannotEncodeResolution"
    // Source can't be decoded by this browser (canPlay=false), so any export
    // that re-encodes is impossible; export-as-is (stream-copy) still works.
    // The panel note assembles: sourceNotPlayable (why) + the shared browser
    // advice (codecPlaybackAdviceHtml) + .asIs (what works right here).
    | "export.error.sourceNotPlayable"
    | "export.error.sourceNotPlayable.asIs"
    | "export.error.tooLargeForMemory"
    | "export.error.diskFull"
    | "export.error.destinationLost"
    | "export.error.sourceReadFailed"
    | "export.notify.gpmfFailed"
    | "export.notify.mapDropped"
    | "export.notify.damagedEnd"
    | "export.notify.audioFormatMixed"
    | "export.notify.audioEncodeUnsupported"
    | "export.notify.audioFallbackOpus"

    // Settings modal: the gear icon in the header opens this modal. Contains a
    // "Privacy" tab (crash-reports toggle) and other preferences (trip grouping
    // threshold, etc.).
    | "settings.entry.title"
    | "settings.modal.title"
    | "settings.modal.close"
    | "settings.privacy.section"
    | "settings.privacy.policyLink"
    // Crash reports (Sentry, errors-only).
    | "settings.privacy.crash.label"
    | "settings.privacy.crash.description"

    // Settings -> Playback: unit preference (km/h + km vs mph + mi). Affects
    // chart speed axis, map popup speed, trip distance display, feedback report.
    // Stored in localStorage["everydashcam:units"]; default autodetected from
    // navigator.language (US/UK/Liberia/Myanmar/Belize -> imperial).
    | "settings.playback.section"
    | "settings.playback.units.label"
    | "settings.playback.units.metric"
    | "settings.playback.units.imperial"
    // Arrow-key seek step. Two separate inputs - plain Arrow and Shift+Arrow.
    // Defaults 5s / 30s. Stored in localStorage["everydashcam:hotkeys:seekStepSec"]
    // and "...seekStepShiftSec".
    | "settings.playback.seekStep.label"
    | "settings.playback.seekStep.description"
    | "settings.playback.seekStep.arrow"
    | "settings.playback.seekStep.shiftArrow"
    | "settings.playback.seekStep.unit"

    // Settings -> Map: label-size multiplier for street/place names on the live
    // maps. Presets in src/ui/map-label-scale.ts (stored in
    // localStorage["everydashcam:mapLabelScale"]); the export overlay map has its
    // own per-export control (export.overlays.mapLabelSize).
    | "settings.map.section"
    | "settings.map.provider.label"
    | "settings.map.provider.openfreemap"
    | "settings.map.provider.openstreetmap"
    | "settings.map.provider.yandex"
    | "settings.map.provider.unavailable"
    | "settings.map.provider.description"
    | "settings.map.styleUnavailable"
    | "settings.map.style.label"
    | "settings.map.style.classic"
    | "settings.map.style.road"
    | "settings.map.style.minimal"
    | "settings.map.theme.label"
    | "settings.map.theme.auto"
    | "settings.map.theme.light"
    | "settings.map.theme.dark"
    | "settings.map.buildings3d.label"
    | "settings.map.buildings3d.description"
    | "settings.map.marker.label"
    | "settings.map.marker.description"
    | "settings.map.marker.shape.label"
    | "settings.map.marker.shape.arrow"
    | "settings.map.marker.shape.sedan"
    | "settings.map.marker.shape.suv"
    | "settings.map.marker.shape.motorcycle"
    | "settings.map.marker.shape.van"
    | "settings.map.marker.shape.truck"
    | "settings.map.marker.color.label"
    | "settings.map.marker.color.white"
    | "settings.map.marker.color.black"
    | "settings.map.marker.color.gray"
    | "settings.map.marker.color.silver"
    | "settings.map.marker.color.blue"
    | "settings.map.marker.color.red"
    | "settings.map.marker.color.green"
    | "settings.map.marker.color.orange"
    | "settings.map.marker.color.custom"
    | "settings.map.marker.size.label"
    | "settings.map.marker.size.small"
    | "settings.map.marker.size.medium"
    | "settings.map.marker.size.large"
    | "settings.map.labelScale.label"
    | "settings.map.labelScale.standard"
    | "settings.map.labelScale.description"
    // Street-name density on the live maps: how often road names repeat and
    // how early by zoom they turn on. Presets and the style transform in
    // src/ui/map-label-scale.ts; also surfaced in the map gear popover.
    | "settings.map.streetNames.label"
    | "settings.map.streetNames.standard"
    | "settings.map.streetNames.more"
    | "settings.map.streetNames.max"
    | "settings.map.streetNames.description"

    // Settings -> Events: automatic impact/brake detection threshold in g.
    // Below this value, accel-spikes don't get a marker on the chart/map/strip.
    // Default 0.5g (tuned for 70mai x800). User can raise it on rough roads
    // (suspension noise) or lower it for a more sensitive trip review.
    // Stored in localStorage["everydashcam:events:brakeThresholdG"]; "off"
    // disables detection entirely.
    | "settings.events.section"
    | "settings.events.threshold.label"
    | "settings.events.threshold.description"
    | "settings.events.threshold.unit"
    | "settings.events.threshold.off"

    // Settings -> Ingest: trip grouping threshold. How large a time gap between
    // consecutive clips before they get split into separate trips. Default 30s;
    // presets cover stopover-friendly long hauls (5m/15m/60m) and "treat
    // everything as one trip" (off). Stored as seconds (or "off") in
    // localStorage["everydashcam:trips:gapSec"].
    | "settings.ingest.section"
    | "settings.ingest.gap.label"
    | "settings.ingest.gap.description"
    | "settings.ingest.gap.unit"
    | "settings.ingest.gap.never"
    | "migration.title"
    | "migration.body"
    | "migration.transfer"
    | "migration.restoreFile"
    | "migration.dismiss"
    | "settings.migration.section"
    | "settings.migration.announcement"
    | "settings.migration.export"
    | "settings.migration.restore"
    | "settings.migration.recover"
    | "settings.migration.installed"

    // Settings -> portable trip-notes backup.
    | "settings.notes.section"
    | "settings.notes.description"
    | "settings.notes.export"
    | "settings.notes.import"

    // Settings -> Recordings cache: the cross-session index cache
    // (src/persist/index-cache.ts). Usage readout, configurable size limit
    // (src/persist/cache-limit.ts) and a clear action that wipes only cached
    // indexing results - folders and annotations survive.
    | "settings.cache.section"
    | "settings.cache.description"
    | "settings.cache.usage.label"
    | "settings.cache.usage.value"
    | "settings.cache.limit.label"
    | "settings.cache.limit.unit"
    | "settings.cache.limit.description"
    | "settings.cache.clear.label"
    | "settings.cache.clear.description"
    | "settings.cache.clear.done"

    // Settings -> About & diagnostics. Read-only info (version, storage
    // estimate) plus support actions: download the in-memory log ring buffer
    // (for bug reports) and "Clear offline cache" - lighter than Danger zone
    // reset, only wipes Cache Storage and unregisters the SW, keeps user
    // preferences intact.
    | "settings.about.section"
    | "settings.about.version.label"
    | "settings.about.storage.label"
    | "settings.about.storage.value"
    | "settings.about.storage.unknown"
    | "settings.about.download.label"
    | "settings.about.download.description"
    | "settings.about.clearCache.label"
    | "settings.about.clearCache.description"

    // Settings -> Danger zone: full local-state reset. Wipes localStorage,
    // sessionStorage, cookies, Cache Storage, IndexedDB, unregisters the SW
    // and hard-reloads. .note explains what we cannot clear from JS (PWA
    // shortcut, browser permissions). confirm.* are the second-step modal.
    | "settings.danger.section"
    | "settings.danger.description"
    | "settings.danger.cta"
    // Replay-tips control (resets onboarding-tour seen-state). Lives in the
    // settings Danger zone; .done is the confirmation toast.
    | "settings.danger.onboarding.description"
    | "settings.danger.onboarding.cta"
    | "settings.danger.onboarding.done"
    | "settings.danger.confirm.title"
    | "settings.danger.confirm.body"
    | "settings.danger.confirm.note"
    | "settings.danger.confirm.cta"
    | "settings.danger.confirm.cancel"

    // Landing page footer with a link to the privacy policy. CalOPPA requires
    // a "clear and conspicuous" link containing the word "Privacy" - the link
    // text must include "Privacy" / "Конфиденциальность".
    | "footer.privacy"
    | "footer.terms"
    // Footer link to /third-party-notices.txt - the license texts the bundled
    // MIT/BSD/MPL dependencies require us to ship with the distribution
    // (generated by scripts/generate-third-party-notices.mjs).
    | "footer.licenses"
    | "footer.compare"
    // Footer link to the source repository. Short label next to a GitHub mark,
    // so it does not have to carry the word "GitHub" in every locale.
    | "footer.source"
    // Link to the "help us add your dashcam" page (public/add-my-camera.html).
    | "footer.addCamera"
    // Footer credit line - leads into the open-source projects we build on
    // (Mediabunny, MapLibre, Chart.js, OpenFreeMap). Names stay literal across
    // locales (proper nouns); only this lead-in label is translated.
    | "footer.builtWith"

    // PWA install. The topbar button (#install-btn) is shown only when the
    // app is installable. Strings:
    //  - install.cta - short label for the icon's aria-label/title and CTAs;
    //  - toast.* - one-shot slide-up after the first successful ingest;
    //  - guide.* - guide modal for browsers without an install API
    //    (Safari macOS - point the user to Chrome for offline support);
    //  - guide.chromium.* - hint for a Chromium user whose
    //    beforeinstallprompt has not fired yet (Chrome requires engagement
    //    before considering a site installable).
    | "pwa.install.cta"
    | "pwa.toast.title"
    | "pwa.toast.body"
    | "pwa.toast.install"
    | "pwa.toast.dismiss"

    // Author’s note in About and the optional returning-use reminder.
    | "supportPrompt.title"
    | "supportPrompt.body"
    | "supportPrompt.reason"
    | "supportPrompt.github"
    | "supportPrompt.copy"
    | "supportPrompt.copied"
    | "supportPrompt.copyFailed"
    | "supportPrompt.close"
    | "pwa.guide.title"
    | "pwa.guide.close"
    | "pwa.guide.safariMac.intro"
    | "pwa.guide.safariMac.step1"
    | "pwa.guide.safariMac.step2"
    | "pwa.guide.safariMac.step3"
    | "pwa.guide.safariMac.cta"
    | "pwa.guide.chromium.intro"
    | "pwa.guide.chromium.step1"
    | "pwa.guide.chromium.step2"
    // "Already installed" guide. Shown when the user clicks the install
    // button but at-click detection reports the PWA is already installed
    // (matchMedia / getInstalledRelatedApps / cross-window signal). There
    // is no JS API to launch an installed PWA from a browser tab, so the
    // best we can do is point at where it actually lives - dock, taskbar,
    // app drawer, plus Chrome's address-bar "Open in app" icon.
    | "pwa.installed.title"
    | "pwa.installed.body"
    | "pwa.installed.chromiumHint"

    // Lang-suggestion banner. Shown when the URL carries an explicit locale
    // segment (e.g. /ru/) but navigator.language points at a different
    // locale that we support. The user might have followed a share-link
    // from a friend on the wrong language - the banner offers a one-click
    // switch without breaking the share-safe URL rule (no auto-redirect).
    //
    // Copy is rendered in the BROWSER language (target), not the URL
    // language. Language names come from Intl.DisplayNames(navigatorLang)
    // - we don't ship an NxN langName matrix.
    //
    // ICU params:
    //   {urlLang}     - name of the URL's locale in the browser's language
    //   {browserLang} - name of the browser's locale in the browser's language
    | "langBanner.message"
    | "langBanner.open"
    | "langBanner.dismiss"
    | "langBanner.regionLabel"

    // Onboarding tours (src/ui/onboarding.ts). Four guided "spotlight" tours
    // (ingest / player / export / multichannel), each <=4 short steps. Shared
    // controls first, then per-tour step title/body pairs. ICU params in
    // onboard.counter: {current}, {total}.
    | "onboard.next"
    | "onboard.back"
    | "onboard.done"
    | "onboard.skip"
    | "onboard.dismiss"
    | "onboard.counter"
    | "onboard.dialogLabel"
    | "onboard.ingest.trips.title"
    | "onboard.ingest.trips.body"
    | "onboard.sources.remember.title"
    | "onboard.sources.remember.body"
    | "onboard.player.timeline.title"
    | "onboard.player.timeline.body"
    | "onboard.player.export.title"
    | "onboard.player.export.body"
    | "onboard.export.range.title"
    | "onboard.export.range.body"
    | "onboard.export.output.title"
    | "onboard.export.output.body"
    | "onboard.multi.layout.title"
    | "onboard.multi.layout.body"
    | "onboard.multi.channels.title"
    | "onboard.multi.channels.body";
