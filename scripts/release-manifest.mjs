import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const cargoToml = readFileSync(new URL("collector/Cargo.toml", root), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const version = process.env.RELEASE_VERSION ?? packageJson.version;
const commit = process.env.GITHUB_SHA ?? "local";
const refName = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
const tag = process.env.RELEASE_TAG ?? (refName?.startsWith("v") ? refName : `v${version}`);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Release version must be valid SemVer");
if (packageJson.version !== cargoVersion) throw new Error(`Version mismatch: package.json=${packageJson.version}, Cargo.toml=${cargoVersion}`);
if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match version v${version}`);
const manifest = {
  name: "resilient-delivery",
  version,
  tag,
  commit,
  components: {
    webSdk: packageJson.version,
    nodeSdk: version,
    collector: cargoVersion,
    otlpGateway: "opentelemetry-collector-contrib:0.120.0",
  },
  releaseChecks: ["web-sdk", "browser-matrix", "collector", "security-audit", "network-resilience", "otlp-gateway", "container-image", "physical-compaction", "backup-restore"],
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
