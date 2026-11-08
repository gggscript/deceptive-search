// `bun run deploy`: publish the visualizer at https://deceptive-search.gustaf.website/visualization/<commit>/
// and point /visualization/latest/ at it. Old commits stay online, so links that name a commit keep working.
//
//   bun run deploy           build the last commit and upload it
//   bun run deploy --setup   once: add the site to Caddy on the server (backs up the Caddyfile first)
//
// The server is the yapmap VPS (`ssh horst`, see experiments/yapmap/deploy/README.md). Caddy serves
// /srv/deceptive-search as static files; DNS for deceptive-search.gustaf.website already points there.

import { join } from "node:path"

const root = join(import.meta.dir, "..")
const host = process.env["DECEPTIVE_SEARCH_DEPLOY_SSH"] ?? "horst"
const serverDirectory = "/srv/deceptive-search"
const domain = "deceptive-search.gustaf.website"

function run(command: string[], options: { input?: string } = {}) {
	const result = Bun.spawnSync(command, { cwd: root, stdin: options.input === undefined ? "inherit" : new TextEncoder().encode(options.input), stdout: "pipe", stderr: "pipe" })
	const output = result.stdout.toString() + result.stderr.toString()
	if (result.exitCode !== 0) {
		console.error(`failed: ${command.join(" ")}\n${output}`)
		process.exit(1)
	}
	return output.trim()
}

const CADDY_SITE = `
# deceptive-search visualizer (repo experiments/deceptive-search, \`bun run deploy\`).
# Static files: one folder per commit under /visualization/<commit>/, "latest" links to the newest.
${domain} {
	encode zstd gzip
	root * ${serverDirectory}
	redir / /visualization/latest/ 302
	file_server
	header Strict-Transport-Security "max-age=31536000"
}
`

if (process.argv.includes("--setup")) {
	// Safe to run again: adds the site only if missing, and always validates and reloads.
	// validate needs the Cloudflare token the other sites' configs use (the service gets it from this file).
	const script = `set -e
if grep -q '^${domain} {' /etc/caddy/Caddyfile; then echo "site already in the Caddyfile"; cat > /dev/null
else cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F); cat >> /etc/caddy/Caddyfile; echo "added the site"; fi
mkdir -p ${serverDirectory}/visualization
(set -a; [ -f /etc/caddy/cloudflare.env ] && . /etc/caddy/cloudflare.env; set +a; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1) || { echo "caddy validate failed"; exit 1; }
systemctl reload caddy
echo "reloaded Caddy: https://${domain}/"`
	console.log(run(["ssh", host, script], { input: CADDY_SITE }))
	process.exit(0)
}

// What ships is the last commit: refuse uncommitted changes, so a link's commit really is the code.
const changes = run(["git", "status", "--porcelain"])
if (changes) {
	console.error(`commit first; uncommitted changes:\n${changes}`)
	process.exit(1)
}
const commit = run(["git", "rev-parse", "--short=10", "HEAD"])
console.log(run(["bun", "viz/build.ts"]))

const target = `${serverDirectory}/visualization/${commit}`
run(["ssh", host, `mkdir -p ${target}`])
run(["scp", "-q", join(root, "viz", "out", "index.html"), `${host}:${target}/index.html`])
run(["ssh", host, `ln -sfn ${commit} ${serverDirectory}/visualization/latest`])

// versions.json: every deployed commit, newest first, for the page's version menu (date and message from local git).
const deployed = run(["ssh", host, `ls -1 ${serverDirectory}/visualization`]).split("\n").filter((name) => /^[0-9a-f]{7,40}$/.test(name))
const versions = deployed.map((folder) => {
	const [time, date, message] = run(["git", "show", "-s", "--format=%ct%x09%cs%x09%s", folder]).split("\t")
	return { commit: folder, time: Number(time), date: date ?? "", message: message ?? "" }
}).sort((a, b) => b.time - a.time).map(({ time, ...version }) => version)
run(["ssh", host, `cat > ${serverDirectory}/visualization/versions.json`], { input: JSON.stringify(versions) })
console.log(`https://${domain}/visualization/${commit}/\nhttps://${domain}/visualization/latest/ now points there`)
