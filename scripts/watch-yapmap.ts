// Prints each new yapmap turn as one stdout line, once its text stopped changing between two polls
// (speech-to-text revises the newest turn while you're still talking).
// Usage: bun scripts/watch-yapmap.ts <session id|url> [--after <n>] [--every <seconds>]

const CLI = "C:/Users/curio/~/old/v3/javascript/experiments/yapmap/cli/yapmap.ts"

const args = process.argv.slice(2)
function opt(name: string, fallback: number) {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? Number(args[i + 1]) : fallback
}
const session = args[0] ?? ""
if (!session) throw new Error("usage: watch-yapmap.ts <session> [--after n] [--every s]")

let lastEmitted = opt("after", 0)
const everyMs = opt("every", 15) * 1000
let previous = new Map<number, string>()
let failing = false

type Turn = { n: number; text: string; startClock: string; turnId: string }

async function poll() {
	const proc = Bun.spawn(["bun", CLI, "read", session, "--json", "--all"], { stdout: "pipe", stderr: "pipe" })
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	if (code !== 0) throw new Error(err.trim().split("\n")[0] || `exit ${code}`)
	return out.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn)
}

while (true) {
	try {
		const turns = (await poll()).filter((turn) => turn.n > lastEmitted).sort((left, right) => left.n - right.n)
		for (const turn of turns) {
			if (previous.get(turn.n) !== turn.text) break // still changing; keep order, so stop here
			console.log(`[${turn.startClock} #${turn.n}] ${turn.text}`)
			lastEmitted = turn.n
		}
		previous = new Map(turns.map((turn) => [turn.n, turn.text]))
		if (failing) console.log("watch-yapmap: reading works again")
		failing = false
	} catch (error) {
		if (!failing) console.log(`watch-yapmap error: ${(error as Error).message}`)
		failing = true
	}
	await Bun.sleep(everyMs)
}
