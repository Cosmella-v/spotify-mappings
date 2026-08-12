const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const rootDir = path.join(__dirname, "..");
const mappingsDir = path.join(rootDir, "Mappings");

const outputYaml = path.join(rootDir, "mappings.yaml");
const outputJson = path.join(rootDir, "mappings.json");

const files = fs
  .readdirSync(mappingsDir)
  .filter(
    file =>
      file.endsWith(".yaml") ||
      file.endsWith(".yml")
  )
  .sort();

console.log(`Found ${files.length} mapping files`);

const combined = {};

for (const file of files) {
  console.log(`Reading ${file}...`);

  const filePath = path.join(mappingsDir, file);
  const content = fs.readFileSync(filePath, "utf8");

  const mappings = YAML.parse(content);

  if (!mappings || typeof mappings !== "object") {
    continue;
  }

  for (const [name, ids] of Object.entries(mappings)) {
    if (!Array.isArray(ids)) {
      console.warn(
        `Skipping "${name}" in ${file}: expected an array`
      );

      continue;
    }

    if (!combined[name]) {
      combined[name] = new Set();
    }

    for (const id of ids) {
      combined[name].add(id);
    }
  }
}

const result = Object.fromEntries(
  Object.entries(combined).map(([name, ids]) => [
    name,
    [...ids],
  ])
);

// WRITE BOTH YAML AND JSON OUTPUT
fs.writeFileSync(
  outputYaml,
  YAML.stringify(result)
);

const jsonMappings = {};

for (const [name, ids] of Object.entries(result)) {
  for (const id of ids) {
    jsonMappings[id] = name;
  }
}

fs.writeFileSync(
  outputJson,
  JSON.stringify(jsonMappings, null, 2) + "\n"
);

console.log(`Created ${outputYaml}!`);
console.log(`Created ${outputJson}!`);