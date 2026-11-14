# NEARWOLF UI

Open `index.html` in Chrome. No build step. three.js r160 is vendored in `vendor/` (pinned, same file as the jsDelivr CDN build); fonts come from Google Fonts.

| URL | What |
|---|---|
| `index.html` | **Play mode.** You are Ash. The show stops at each of your decisions (sit down, break the seal, night action, table move, vote). `Space` pauses, `→` or "Skip" jumps to the next beat, `?speed=2` plays faster. |
| `index.html?director=1` | **Director mode.** The full scripted game on a fixed timeline (about 246 s). |
| `index.html?director=1&cut=trailer` | A shorter cut (about 144 s): day 1 in full, then Maud's reveal, Hale's banishment, the ending. |

## Recording (director mode)

```js
await page.waitForFunction('window.director && director.ready');
for (let f = 0; f < director.duration / 1000 * 60; f++) { director.seek(f * 1000 / 60); /* screenshot */ }
```

`window.director = { duration, seek(ms), scenes: [{id, start, end}], play(), ready }`. `seek()` renders synchronously and stops autoplay.
Every frame is a pure function of the timeline time (`render(t)` in `app.js`): no `Math.random`, no wall clock.
Two seeks to the same time give the same picture (checked: at most one pixel off by one level, from the browser compositor).

## Plugging in real game state

The UI only reads a `NearwolfView` (typed in the header of `story.js`): your seat's private view, the public log, and what the keeper is waiting on from you. Write an adapter with `start(onView)` and `act(choice)` and boot with it:

```html
<script>window.NEARWOLF_BOOT = { adapter: myMakeoAdapter };</script>  <!-- before app.js -->
```

`createMockAdapter()` in `story.js` is the scripted story. It keeps the story on script whatever you pick.

## Portraits

Put painted portraits (3:4, about 768x1024) in `assets/portraits/` and list them in `assets/portraits/manifest.js`. Seats without a file use the generated silhouette. Serve over http (`python3 -m http.server`) so WebGL may read image files; under `file://` the 3D scene falls back to silhouettes.

## Files

`app.js` timeline engine, 3D scene, all screens · `story.js` state interface, mock adapter, script · `portraits.js` portrait loader and placeholders · `style.css` · `shots/` screenshots.
