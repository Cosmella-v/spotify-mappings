const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { isDeepStrictEqual } = require("util");
const YAML = require("yaml");

const rootDir = path.join(__dirname, "..");
const patternsDir = path.join(__dirname, "Patten");
const mappingsDir = path.join(rootDir, "Mappings");
const tempJsonFile = path.join(__dirname, "SigScan.json");
const tempManifestFile = path.join(__dirname, "SigScanFiles.json");
const tempCurrentFile = path.join(__dirname, "SigScanCurrent.json");

const START_URL = process.env.SPOTIFY_URL || "https://open.spotify.com/";
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CONCURRENCY = 8;
const MAX_FILES = 2000;

const EXTRA_URLS_FILE = process.argv[2] || process.env.SPOTIFY_EXTRA_URLS;

fs.mkdirSync(mappingsDir, { recursive: true });

// ---------- Downloading ----------
async function fetchText(url) {
    const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
        redirect: "follow",
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
}

function urlToRelative(url) {
    const u = new URL(url);
    let p = u.pathname.replace(/^\/+/, "");
    if (!p || p.endsWith("/")) p += "index.html";
    return `${u.hostname}/${p}`.replace(/[<>:"|?*]/g, "_");
}

// Pull candidate JS URLs out of HTML/JS source.
function extractUrls(source, baseUrl, buildBase) {
    const found = new Set();
    const add = (raw, base) => {
        try {
            const u = new URL(raw, base);
            if (!/^https?:$/.test(u.protocol)) return;
            if (!u.pathname.endsWith(".js") && !u.pathname.endsWith(".mjs")) return;
            if (!/(^|\.)spotify(cdn)?\.com$|\.scdn\.co$/.test(u.hostname)) return;
            u.hash = "";
            found.add(u.href);
        } catch { }
    };

    // <script src="...">, <link href="...js">, modulepreload
    for (const m of source.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.m?js[^"']*)["']/gi)) {
        add(m[1], baseUrl);
    }
    // Absolute / protocol-relative URLs inside JS strings
    for (const m of source.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s\\]+?\.m?js)["'`]/g)) {
        add(m[1], baseUrl);
    }
    // Hashed chunk filenames, resolved against the build folder
    for (const m of source.matchAll(/["'`]((?:[\w~.-]+\/)*[\w~.-]+\.[0-9a-f]{6,}\.m?js)["'`]/g)) {
        add(m[1], buildBase || baseUrl);
    }
    return found;
}

// ---------- Lazy chunk discovery helpers ----------
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Yields every flat {key:"value",...} object literal found in a source file.
function* flatMaps(text) {
    const re = /\{((?:(?:[\w$]+|"[^"]*"):"[^"]*",?)+)\}/g;
    for (const m of text.matchAll(re)) {
        const map = {};
        for (const e of m[1].matchAll(/(?:([\w$]+)|"([^"]*)"):"([^"]*)"/g)) {
            map[e[1] ?? e[2]] = e[3];
        }
        yield map;
    }
}

// Works out chunk URLs from webpack-style maps. Handles both layouts:
//   {"pip-mini-player":"1fadab3f"}                    (name -> hash)
//   {1234:"pip-mini-player"} + {1234:"1fadab3f"}      (id -> name, id -> hash)
function discoverLazyChunks(files, buildBase, wanted) {
    const HEX = /^[0-9a-f]{6,}$/;
    const nameMap = {}; // id -> chunk name
    const hashMaps = [];

    for (const f of files) {
        const text = fs.readFileSync(f.path, "utf8");
        for (const map of flatMaps(text)) {
            const keys = Object.keys(map);
            const vals = Object.values(map);
            if (vals.every(v => HEX.test(v))) {
                hashMaps.push(map);
            } else if (keys.every(k => /^\d+$/.test(k)) && vals.every(v => /^[\w~.-]+$/.test(v))) {
                Object.assign(nameMap, map);
            }
        }
    }

    const urls = new Set();
    for (const map of hashMaps) {
        for (const [key, hash] of Object.entries(map)) {
            const name = nameMap[key] ?? key;
            if (!wanted.test(name)) continue;
            // can't tell which map is js and which is css, so try both; wrong guesses 404 and are skipped
            for (const ext of ["js", "css"]) urls.add(`${buildBase}${name}.${hash}.${ext}`);
        }
    }
    return urls;
}

// Prints the text around mentions of the lazy chunk names, to see how they're really referenced.
function showMentions(files, names) {
    let total = 0;
    for (const name of names) {
        let shown = 0;
        for (const f of files) {
            const text = fs.readFileSync(f.path, "utf8");
            for (const m of text.matchAll(new RegExp(escRe(name), "g"))) {
                if (shown++ >= 3) break;
                total++;
                const snip = text.slice(Math.max(0, m.index - 150), m.index + 200).replace(/\s+/g, " ");
                console.log(`  [${name}] ${f.relative} @${m.index}: ${snip}`);
            }
            if (shown >= 3) break;
        }
    }
    if (!total) console.log("  (none of the lazy chunk names appear in any downloaded file)");
}

// ---------- Main download ----------
async function downloadWebPlayer(destDir) {
    const files = new Map(); 
    const seen = new Set();
    let buildBase = null;
    let buildHash = null;

    async function save(url, content) {
        const relative = urlToRelative(url);
        const full = path.join(destDir, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
        files.set(url, { path: full, relative });
    }

    console.log(`Fetching ${START_URL}...`);
    const html = await fetchText(START_URL);
    await save(START_URL, html);

    const extra = EXTRA_URLS_FILE && fs.existsSync(EXTRA_URLS_FILE)
        ? fs.readFileSync(EXTRA_URLS_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean)
        : [];

    const fromHtml = [...extractUrls(html, START_URL, null)];
    console.log(`Scripts in HTML:\n${fromHtml.map(u => `  ${u}`).join("\n") || "  (none)"}`);

    let queue = [...fromHtml, ...extra];

    // Main bundle gives us the build folder + build hash
    for (const u of queue) {
        const m = u.match(/^(.*\/)web-player\.([0-9a-f]+)\.js/);
        if (m) {
            buildBase = m[1];
            buildHash = m[2];
            break;
        }
    }

    // Fallback: any URL inside the web-player build folder is enough to get the folder
    if (!buildBase) {
        for (const u of queue) {
            const m = u.match(/^(.*\/cdn\/build\/web-player\/)/);
            if (m) {
                buildBase = m[1];
                break;
            }
        }
    }
    console.log(`Build folder: ${buildBase || "(not found)"}  hash: ${buildHash || "(not found)"}`);

    // 3. Crawl: fetch each file, look for more chunk references
    async function drain() {
        while (queue.length && files.size < MAX_FILES) {
            const batch = queue.splice(0, CONCURRENCY).filter(u => !seen.has(u));
            batch.forEach(u => seen.add(u));

            const results = await Promise.all(
                batch.map(async url => {
                    try {
                        return { url, text: await fetchText(url) };
                    } catch (e) {
                        // 403/404 are expected for the js/css guesses below, so keep those quiet
                        if (!/^(403|404)/.test(e.message)) console.warn(`  skip ${url} (${e.message})`);
                        return null;
                    }
                })
            );

            for (const r of results) {
                if (!r) continue;
                await save(r.url, r.text);
                for (const next of extractUrls(r.text, r.url, buildBase)) {
                    if (!seen.has(next)) queue.push(next);
                }
            }
        }
    }

    await drain();

    // 4. Lazy chunks (miniplayer etc.) that webpack only knows through its chunk maps
    const LAZY = (process.env.SPOTIFY_LAZY || "pip-mini-player,vendor~web-player")
        .split(",").map(s => s.trim()).filter(Boolean);
    const wanted = new RegExp(LAZY.map(escRe).join("|"));

    if (buildBase) {
        let totalFound = 0;

        // a couple of passes, since newly fetched chunks can reference more chunks
        for (let pass = 0; pass < 3; pass++) {
            const candidates = [...discoverLazyChunks([...files.values()], buildBase, wanted)]
                .filter(u => !seen.has(u));
            if (!candidates.length) break;

            totalFound += candidates.length;
            console.log(`Lazy chunk candidates (pass ${pass + 1}): ${candidates.length}`);
            queue.push(...candidates);
            await drain();
        }

        const got = [...files.keys()].filter(u => wanted.test(u));
        console.log(`Lazy chunks downloaded: ${got.length}`);
        got.forEach(u => console.log(`  ${u}`));

        if (!got.length) {
            console.log(`No lazy chunks found (${totalFound} candidates tried). Mentions in the downloaded files:`);
            showMentions([...files.values()], LAZY);
        }
    } else {
        console.warn("Could not work out the build folder, skipping lazy chunks.");
    }

    console.log(`Downloaded ${files.size} files.`);
    return { files: [...files.values()], buildHash };
}

function contentHash(files) {
    const hash = crypto.createHash("sha256");
    for (const f of [...files].sort((a, b) => a.relative.localeCompare(b.relative))) {
        hash.update(f.relative);
        hash.update("\0");
        hash.update(fs.readFileSync(f.path));
        hash.update("\0");
    }
    return hash.digest("hex").slice(0, 12);
}

async function main() {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-web-"));

    try {
        const { files: downloaded, buildHash } = await downloadWebPlayer(workDir);

        const scanFiles = downloaded
            .sort((a, b) => a.relative.localeCompare(b.relative))
            .map(f => {
                const src = fs.readFileSync(f.path, "utf8");
                return {
                    path: f.path,
                    relative: f.relative,
                    kind: /mini[-_]?player|\bpip\b/i.test(f.relative) ? "miniplayer" : "web",
                    mentionsMiniplayer: /miniplayer/i.test(src),
                };
            });

        if (scanFiles.length <= 1) {
            console.error("No JS files were found on the page. Spotify may have blocked the request.");
            process.exit(1);
        }

        const spotifyHash = buildHash || contentHash(scanFiles);
        const outputFile = path.join(mappingsDir, `autoScan-${spotifyHash}.yaml`);

        console.log(
            `Spotify hash: ${spotifyHash}${buildHash ? " (web-player build)" : " (content hash)"} ` +
            `- ${scanFiles.length} files, ` +
            `${scanFiles.filter(f => f.kind === "miniplayer").length} miniplayer-named, ` +
            `${scanFiles.filter(f => f.mentionsMiniplayer).length} mention miniplayer`
        );

        fs.writeFileSync(
            tempManifestFile,
            JSON.stringify({ spotifyDir: workDir, spotifyHash, files: scanFiles }, null, 2),
            "utf8"
        );

        const patternFiles = fs
            .readdirSync(patternsDir)
            .filter(file => file.endsWith(".js") || file.endsWith(".javascript"))
            .sort();

        let currentOutput = {};

        for (const file of patternFiles) {
            console.log(`Running ${file}...`);

            // argv[2] = current output, argv[3] = manifest path
            const result = execFileSync(
                process.execPath,
                [path.join(patternsDir, file), JSON.stringify(currentOutput), tempManifestFile],
                {
                    encoding: "utf8",
                    stdio: ["inherit", "pipe", "inherit"],
                    maxBuffer: 256 * 1024 * 1024,
                    env: {
                        ...process.env,
                        SPOTIFY_DIR: workDir,
                        SPOTIFY_HASH: spotifyHash,
                        SPOTIFY_MANIFEST: tempManifestFile,
                    },
                }
            );

            currentOutput = JSON.parse(result);
        }

        fs.writeFileSync(tempJsonFile, JSON.stringify(currentOutput, null, 2), "utf8");

        console.log(`Converting to ${outputFile}...`);
        execFileSync(
            process.execPath,
            [path.join(__dirname, "jsonToYaml.js"), tempJsonFile, outputFile],
            { stdio: "inherit" }
        );

        const newScan = YAML.parse(fs.readFileSync(outputFile, "utf8"));

        const oldFiles = fs
            .readdirSync(mappingsDir)
            .filter(file =>
                /^autoScan-[0-9a-zA-Z]+\.yaml$/.test(file) &&
                file !== path.basename(outputFile)
            );

        for (const oldFile of oldFiles) {
            const oldPath = path.join(mappingsDir, oldFile);
            console.log(`Checking duplicates in ${oldFile}...`);

            const oldScan = YAML.parse(fs.readFileSync(oldPath, "utf8"));
            const cleanedScan = removeDuplicates(oldScan, newScan);

            fs.writeFileSync(oldPath, YAML.stringify(cleanedScan), "utf8");
        }

        console.log(`Updated ${oldFiles.length} older scan(s).`);
        console.log(`Saved output to ${outputFile}`);
    } finally {
        for (const f of [tempJsonFile, tempManifestFile]) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

function removeDuplicates(oldValue, newValue) {
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
        return oldValue.filter(
            item => !newValue.some(newItem => isDeepStrictEqual(item, newItem))
        );
    }

    if (
        oldValue !== null && newValue !== null &&
        typeof oldValue === "object" && typeof newValue === "object" &&
        !Array.isArray(oldValue) && !Array.isArray(newValue)
    ) {
        for (const key of Object.keys(oldValue)) {
            if (!Object.prototype.hasOwnProperty.call(newValue, key)) continue;

            if (isDeepStrictEqual(oldValue[key], newValue[key])) {
                delete oldValue[key];
            } else {
                oldValue[key] = removeDuplicates(oldValue[key], newValue[key]);

                const v = oldValue[key];
                if (
                    (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) ||
                    (Array.isArray(v) && v.length === 0)
                ) {
                    delete oldValue[key];
                }
            }
        }
        return oldValue;
    }

    return oldValue;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});