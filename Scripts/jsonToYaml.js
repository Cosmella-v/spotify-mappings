const fs = require("node:fs");

const input = JSON.parse(
  fs.readFileSync(process.argv[2] || "css-map.json", "utf8")
);

const groups = {};

for (const [id, name] of Object.entries(input)) {
  if (!groups[name]) {
    groups[name] = [];
  }

  groups[name].push(id);
}

const output = Object.entries(groups)
  .map(([name, ids]) => {
    return `${name}:\n${ids.map(id => ` - ${id}`).join("\n")}`;
  })
  .join("\n\n");

fs.writeFileSync(process.argv[3] || "output.yaml", output);
