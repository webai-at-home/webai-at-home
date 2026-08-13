# Directory Context: `/packages/worker_webpage/web/src/page`

## Purpose

Everything about the page a volunteer looks at: the markup, the elements it finds, the settings panel, the recent event list, the theme toggle, the about panel, the tooltips, and the two things that try to keep a backgrounded tab from being throttled.

## Key Exports & Entry Points

- `page_markup.ts` and `page_elements.ts`: preparing text for display, and finding the elements a page needs, saying plainly when one is missing.
- `stages_config_panel.ts`: `StagesConfigPanel`, the settings panel a volunteer uses to choose which stages this browser offers.
- `worker_event_log.ts`: `WorkerEventLog`, the recent events list on the worker browser page.
- `about_panel.ts`: `AboutPanel`, naming which build of the worker webpage this browser tab is running.
- `theme_toggle.ts` and `help_tooltips.ts`: the light or dark theme control, and turning every element marked up for a Bootstrap tooltip into one.
- `audio_keepalive.ts` and `screen_wake_lock.ts`: playing a very quiet tone so a hidden tab keeps its full speed, and asking the system to keep the screen on while the tab is visible.

## Rules

- `StagesConfigPanel` reads the stage list from `../stages/stage_catalog.ts`, never a list kept separately here.
- `page_elements.ts` is the one place that looks an element up by its markup identifier; another file in this folder asks it for the element rather than querying the document itself.
- `audio_keepalive.ts` plays the quiet tone that `_idle_experiments` found keeps a hidden tab at full speed; `screen_wake_lock.ts` addresses a different failure, the device's own screen going to sleep, and neither file substitutes for the other.

## Background

- What the quiet tone does to a backgrounded tab is measured in [`packages/_idle_experiments`](../../../../_idle_experiments/), from [issue #83](https://github.com/webai-at-home/webai-at-home/issues/83).
- `ScreenWakeLockState`'s `unsupported` covers both an insecure origin and a browser that never implemented the Screen Wake Lock interface; see [issue #145](https://github.com/webai-at-home/webai-at-home/issues/145).
