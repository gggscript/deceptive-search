// Prints each new yapmap turn as one stdout line, once its text stopped changing between two polls
// (speech-to-text revises the newest turn while you're still talking).
// Turns that already exist at startup are skipped.
// Usage: bun scripts/watch-yapmap.ts <session id|url> [--pollSeconds <seconds>]

const YAPMAP_CLI_PATH = "C:/Users/curio/~/old/v3/javascript/experiments/yapmap/cli/yapmap.ts"

const cliArguments = process.argv.slice(2)
const sessionId = cliArguments[0] ?? ""
if (!sessionId) throw new Error("usage: watch-yapmap.ts <session> [--pollSeconds s]")
const pollSecondsIndex = cliArguments.indexOf("--pollSeconds")
const pollIntervalMs = (pollSecondsIndex >= 0 ? Number(cliArguments[pollSecondsIndex + 1]) : 15) * 1000

// Turn numbers repeat between spoken and written turns, so track turns by id.
type Turn = { turnId: string; n: number; text: string; startClock: string; written: boolean }

async function readTurns(): Promise<Turn[]> {
	const yapmapProcess = Bun.spawn(["bun", YAPMAP_CLI_PATH, "read", sessionId, "--json", "--all"], { stdout: "pipe", stderr: "pipe" })
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(yapmapProcess.stdout).text(),
		new Response(yapmapProcess.stderr).text(),
		yapmapProcess.exited,
	])
	if (exitCode !== 0) throw new Error(stderr.trim().split("\n")[0] || `exit code ${exitCode}`)
	return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Turn)
}

const reportedTurnIds = new Set((await readTurns()).map((turn) => turn.turnId))
let textByTurnIdLastPoll = new Map<string, string>()
let isFailing = false

while (true) {
	await Bun.sleep(pollIntervalMs)
	try {
		const turns = await readTurns()
		for (const turn of turns) {
			if (reportedTurnIds.has(turn.turnId)) continue
			if (textByTurnIdLastPoll.get(turn.turnId) !== turn.text) continue // still changing
			console.log(`[${turn.startClock} #${turn.n}${turn.written ? " written" : ""}] ${turn.text}`)
			reportedTurnIds.add(turn.turnId)
		}
		textByTurnIdLastPoll = new Map(turns.map((turn) => [turn.turnId, turn.text]))
		if (isFailing) console.log("watch-yapmap: reading works again")
		isFailing = false
	} catch (error) {
		if (!isFailing) console.log(`watch-yapmap error: ${(error as Error).message}`)
		isFailing = true
	}
}
