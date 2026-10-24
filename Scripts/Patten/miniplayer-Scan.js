const fs = require("fs");

const currentOutput = JSON.parse(process.argv[2] || "{}");
const manifestPath = process.argv[3] || process.env.SPOTIFY_MANIFEST;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CLS = "[\\w-]{20}"; // CSS-module hashed class name, e.g. _MzIqkUqvXnFzs6PC5GL
const PIP = "\\[data-transition=pip-mini-player\\]";

const cache = new Map();
const read = f => {
    if (!cache.has(f.path)) cache.set(f.path, fs.readFileSync(f.path, "utf8"));
    return cache.get(f.path);
};
const isPip = f => /pip-mini-player/.test(f.relative);
const cssFiles = manifest.files
    .filter(f => f.relative.endsWith(".css"))
    .sort((a, b) => isPip(b) - isPip(a)); // pip css first
    
const starts = decl => new RegExp(`\\.(?<cls>${CLS})\\{${esc(decl)}`);

const UPSELL   = "miniplayer-smallerPlayerUpsell";
const LOGO     = "miniplayer-spotifyLogo_container";
const CONTROLS = "miniplayer-controls-container";

const rules = [
    {
        name: UPSELL, // _MzIqkUqvXnFzs6PC5GL
        re: new RegExp(
            `\\.(?<cls>${CLS})\\{z-index:2;background:linear-gradient\\(#202124 0%,#121212 60\\.66%\\);` +
            `justify-content:center;height:100%;padding:12px;display:none;position:absolute;inset:0;overflow:auto\\}`
        ),
        confirm: (cls, src) =>
            new RegExp(`@media \\(height<300px\\) or \\(width<300px\\)\\{\\.${esc(cls)}\\{display:block\\}`).test(src),
    },
    {
        name: "unk_overlay",
        re: f => f[UPSELL] && new RegExp(
            `spotify__container--is-desktop \\.${esc(f[UPSELL])}\\{background:var\\(--background-press,#000\\)\\}` +
            `\\.(?<cls>${CLS})\\{text-align:center;flex-direction:column;justify-content:center;align-items:center;gap:8px;height:100%;display:flex\\}`
        ),
    },
    {
        name: "unk_Title",
        re: f => f.unk_overlay && new RegExp(`\\.${esc(f.unk_overlay)} \\.(?<cls>${CLS})\\{color:#fff\\}`),
    },
    {
        name: LOGO, 
        re: f => f.unk_overlayTitle && new RegExp(`\\.${esc(f.unk_overlayTitle)}\\{color:#fff\\}\\.(?<cls>${CLS})\\{margin-bottom:8px!important\\}`),
    },
    {
        name: "unk_overlayExtra",
        re: f => f[LOGO] && new RegExp(`\\.${esc(f[LOGO])},\\.(?<cls>${CLS})\\{display:flex\\}`),
    },
    {
        name: "unk_overlayActions", // wrapping row of buttons
        re: f => f.unk_overlayExtra && new RegExp(
            `\\.${esc(f.unk_overlayExtra)}\\{display:flex\\}\\.(?<cls>${CLS})\\{flex-wrap:wrap;justify-content:center;align-items:center;gap:8px;display:flex\\}`
        ),
    },

    // Layout
    { name: "miniplayer-container",  re: starts("--mouse-active-over-controls-fadeout-timeout:") },
    { name: "main",              re: starts("--window-header-bg-color:#202124;--mini-player-display:grid;") },
    {
        name: "miniplayer-background",
        re: new RegExp(
            `spotify__container--is-web \\.(?<cls>${CLS})\\{background:var\\(--window-header-bg-color\\);` +
            `background:linear-gradient\\(180deg, var\\(--window-header-bg-color\\) 0%, #121212 21\\.35%\\)\\}`
        ),
    },
    { name: "unk_controlsOverlay",   re: starts("background-color:var(--over-media-set-background-press,#000000b8);opacity:0;") },
    { name: "unk_windowButton",      re: starts("-webkit-app-region:no-drag;border:none;border-radius:50%;justify-content:center;align-items:center;width:12px;height:12px;") },

    // Album art + track info
    {
        name: "miniplayer-album-icon-container", // grey placeholder box, 181x181
        re: starts("background:var(--background-elevated-base,#242424);color:#ffffffb3;border-radius:12px;flex-direction:column;justify-content:center;align-items:center;width:181px;height:181px;display:flex}"),
    },
    { name: "miniplayer-album-title",  re: starts("color:#fff;grid-area:title;justify-self:start;align-items:baseline;width:100%;display:flex}") },
    { name: "miniplayer-album-artist", re: starts("grid-area:subtitle;width:100%;min-width:0}") },

    // Controls
    {
        name: CONTROLS, // the container-query container (container:player-controls)
        re: new RegExp(
            `\\.(?<cls>${CLS})\\{flex:1;justify-content:center;align-items:center;display:flex\\}` +
            `\\.${CLS}\\{position:relative\\}\\.${CLS}\\{display:none\\}`
        ),
    },
    {
        name: "miniplayer-play-button", // the one child that stays visible when the other controls fade out
        re: f => f[CONTROLS] && new RegExp(`\\.${esc(f[CONTROLS])}>:not\\(\\.(?<cls>${CLS})\\)`),
    },
    {
        name: "miniplayer-controls-list-gap",
        re: new RegExp(
            `\\.(?<cls>${CLS})\\{justify-content:center;align-items:center;gap:12px;display:flex\\}` +
            `@container \\(width<320px\\)\\{\\.\\k<cls>\\{gap:12px\\}\\}`
        ),
    },
    {
        name: "miniplayer-volume-button",
        re: starts("cursor:pointer;border-radius:50%;justify-content:center;align-items:center;width:32px;min-width:32px;height:32px;display:flex}"),
        // the volume slider is revealed when this button is focused
        confirm: (cls, src) => new RegExp(`\\.${esc(cls)}:focus-visible\\+\\.`).test(src),
    },

    // Progress bar
    { name: "progress-bar",            re: starts("touch-action:none;--bg-color:#ffffff4d;") },
    { name: "x-progressBar-fillColor", re: new RegExp(`\\.(?<cls>${CLS})\\{background-color:var\\(--fg-color\\);[^}]*var\\(--progress-bar-transform\\)`) },
    { name: "unk_progressThumb",       re: starts("background-color:var(--fg-color,#fff);z-index:100;width:12px;height:12px;") },
];

const transitions = {
    mediaHandle:        "pip-media-handle",
    media:              "pip-media",
    mediaVideo:         "pip-media-video",
    contextInfo:        "pip-context-info",
    contextInfoMedium:  "pip-context-info-medium",
    contextInfoActions: "pip-context-info-actions",
    jamQrFlip:          "pip-jam-qr-flip",
};
for (const [name, vt] of Object.entries(transitions)) {
    rules.push({
        name,
        re: new RegExp(`${PIP} \\.(?<cls>${CLS})\\{view-transition-name:${esc(vt)}\\}`),
    });
}

const found = {}; // name -> hashed class (used by chained rules)

for (const rule of rules) {
    for (const f of cssFiles) {
        const re = typeof rule.re === "function" ? rule.re(found) : rule.re;
        if (!re) break; // dependency missing
        const src = read(f);
        const m = re.exec(src);
        if (!m) continue;
        if (rule.confirm && !rule.confirm(m.groups.cls, src)) continue;

        found[rule.name] = m.groups.cls;
        break;
    }

    if (!found[rule.name]) {
        console.error(`MISSING ${rule.name}`);
        continue;
    }

    console.error(`found ${found[rule.name]} = ${rule.name}`);

    const hashed = found[rule.name];
    const existing = Array.isArray(currentOutput[hashed]) ? currentOutput[hashed] : [];
    if (!existing.includes(rule.name)) existing.push(rule.name);
    currentOutput[hashed] = existing;
}

process.stdout.write(JSON.stringify(currentOutput));