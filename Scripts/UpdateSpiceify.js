const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const rootDir = path.join(__dirname, "..");
const mappingsDir = path.join(rootDir, "Mappings");
const jsonToYamlScript = path.join(__dirname, "jsonToYaml.js");
const cssMapJson = path.join(rootDir, "css-map.json");
const spiceifyYaml = path.join(mappingsDir, "spiceify.yaml");
const cssMapUrl = "https://raw.githubusercontent.com/spicetify/cli/main/css-map.json";

async function main() {
  fs.mkdirSync(mappingsDir, { recursive: true });

  if (fs.existsSync(spiceifyYaml)) {
    console.log("Removing existing spiceify.yaml...");
    fs.unlinkSync(spiceifyYaml);
  }

  console.log("Fetching Spicetify css-map.json...");

  const response = await fetch(cssMapUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch css-map.json: ${response.status} ${response.statusText}`
    );
  }

  const content = await response.text();

  fs.writeFileSync(cssMapJson, content);

  console.log("Downloaded css-map.json");

  try {
    console.log("Converting css-map.json -> spiceify.yaml...");

    execFileSync(
      process.execPath,
      [
        jsonToYamlScript,
        cssMapJson,
        spiceifyYaml,
      ],
      {
        stdio: "inherit",
      }
    );

    console.log("Updated Mappings/spiceify.yaml");
  } finally {
    if (fs.existsSync(cssMapJson)) {
      fs.unlinkSync(cssMapJson);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});