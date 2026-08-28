#!/usr/bin/env node
// Blind Flange (SIH26117) — start the local model server (ADR-0001, `local`).
//
// `npm run local-model`. One command on Windows, on WSL and on plain Linux;
// it works out which llama.cpp build this machine can actually use, fetches it
// if it is not there, and serves the fleet in `models/` on one port so
// `profile/web/cordis.patch.yml` says the same thing everywhere.
//
// ## Why there is a choice to make at all
//
// The `local` provider wants the GPU, and llama.cpp publishes a CUDA build for
// **Windows only** — there is no prebuilt Linux CUDA binary, and building one
// needs the CUDA toolkit and a long compile. On this project's hardware the
// other GPU routes are closed too: WSL2 exposes CUDA but ships no Vulkan ICD,
// and Ubuntu's Mesa carries no Dozen driver, so the Vulkan build finds no
// device (verified 29 Aug 2026).
//
// What makes that survivable is WSL interop: a Windows executable runs from
// WSL against the same GPU, reads models over `\\wsl.localhost\...`, and
// serves loopback that both sides share. So WSL gets the GPU by running the
// Windows build — not by pretending Linux has one.
//
//   Windows      -> the CUDA build, GPU
//   WSL          -> the CUDA build through interop, GPU  (`--cpu` to opt out)
//   plain Linux  -> the Linux build, CPU
//
// Measured on a 12,615-token prompt, 29 Aug 2026: 31 tok/s CPU, 168 tok/s GPU.
//
// Node builtins only, by policy — a launcher is not a reason to widen the
// licence allow-list.
//
// Usage:
//   npm run local-model                 # best available for this machine
//   npm run local-model -- --cpu        # force the CPU build
//   npm run local-model -- --port 8795  # anything else is passed to llama-server

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(repoRoot, "models");

/** Pinned, like the harness is: llama.cpp is a fast-moving project and a demo should not move under us. */
const BUILD = "b10679";
const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}`;

/** Where each build lands. Both are gitignored — fetched, not tracked, the way the harness is. */
const BUILDS = {
	linux: {
		dir: join(repoRoot, "vendor", "llama.cpp"),
		binary: "llama-server",
		archives: [`${RELEASE}/llama-${BUILD}-bin-ubuntu-x64.tar.gz`],
		label: "the Linux CPU build",
	},
	windows: {
		dir: join(repoRoot, "vendor", "llama.cpp-win-cuda"),
		binary: "llama-server.exe",
		// The CUDA runtime ships separately from the binaries that need it.
		archives: [`${RELEASE}/llama-${BUILD}-bin-win-cuda-12.4-x64.zip`, `${RELEASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`],
		label: "the Windows CUDA build",
	},
};

const say = (message) => console.log(message);
const step = (message) => console.log(`\n==> ${message}`);

function fail(message) {
	console.error(`\nlocal-model stopped: ${message}\n`);
	process.exit(1);
}

/** WSL announces itself in the kernel version string; the env var is absent under some init setups. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME) return true;
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

/** Whether a Windows executable can actually be launched from here. */
function hasInterop() {
	const probe = spawnSync("cmd.exe", ["/c", "exit"], { stdio: "ignore" });
	return !probe.error && probe.status === 0;
}

/**
 * The path to hand a Windows executable.
 *
 * A Windows build reached through interop cannot read a POSIX path, so the
 * models directory is translated to its `\\wsl.localhost\...` form. Verified
 * 29 Aug 2026: llama-server serves the whole fleet from that UNC path, so the
 * weights stay in one place rather than being duplicated onto the C: drive.
 */
function toWindowsPath(posixPath) {
	const run = spawnSync("wslpath", ["-w", posixPath], { encoding: "utf8" });
	if (run.error || run.status !== 0) fail(`could not translate ${posixPath} for the Windows build (wslpath failed)`);
	return run.stdout.trim();
}

/** Extract a .tar.gz or .zip without adding a dependency for it. */
function extract(archive, into) {
	// GNU tar cannot read zip; bsdtar (Windows, macOS) can. Try unzip first and
	// fall back, so this works on a plain Ubuntu and on Windows alike.
	const attempts = archive.endsWith(".zip")
		? [
				["unzip", ["-oq", archive, "-d", into]],
				["tar", ["-xf", archive, "-C", into]],
			]
		: [["tar", ["xzf", archive, "-C", into, "--strip-components=1"]]];
	for (const [command, args] of attempts) {
		const run = spawnSync(command, args, { stdio: "ignore" });
		if (!run.error && run.status === 0) return;
	}
	fail(`could not extract ${archive}. Install \`unzip\`, or extract it into ${into} by hand.`);
}

/** Fetch and unpack a build if it is not already there. Idempotent, like every other script here. */
function ensureBuild(build) {
	const binary = join(build.dir, build.binary);
	if (existsSync(binary)) return binary;

	step(`Fetching ${build.label} (${BUILD})`);
	say("  This is the only step that uses the network, and it runs once.");
	mkdirSync(build.dir, { recursive: true });
	for (const url of build.archives) {
		const archive = join(build.dir, url.split("/").pop());
		say(`  ${url.split("/").pop()}`);
		const download = spawnSync("curl", ["-sL", "-o", archive, url], { stdio: "inherit" });
		if (download.status !== 0) fail(`downloading ${url} failed. Check the connection, or fetch it by hand into ${build.dir}.`);
		extract(archive, build.dir);
	}
	if (!existsSync(binary)) fail(`${build.label} unpacked but ${build.binary} is not in ${build.dir}`);
	return binary;
}

// ── which build, and how to reach the models ────────────────────────────────

const args = process.argv.slice(2);
const forceCpu = args.includes("--cpu");
const passthrough = args.filter((argument) => argument !== "--cpu");
const port = passthrough.includes("--port") ? passthrough[passthrough.indexOf("--port") + 1] : "8790";

if (!existsSync(modelsDir)) fail(`no models directory at ${modelsDir}. Put the fleet's .gguf files there — see registry/models.yaml.`);

const wsl = isWsl();
let build;
let gpu;
if (process.platform === "win32") {
	build = BUILDS.windows;
	gpu = true;
} else if (wsl && !forceCpu && hasInterop()) {
	build = BUILDS.windows;
	gpu = true;
} else {
	build = BUILDS.linux;
	gpu = false;
	if (wsl && !forceCpu) say("\n  Windows interop is unavailable, so this falls back to the CPU build.");
}

console.log("Blind Flange — the local model server");
console.log(`  platform     ${process.platform === "win32" ? "Windows" : wsl ? "WSL" : "Linux"}`);
console.log(`  build        ${build.label}`);
console.log(`  acceleration ${gpu ? "GPU (CUDA)" : "CPU"}`);

const binary = ensureBuild(build);
// A Windows build launched from WSL needs the models directory in Windows form.
const modelsArgument = build === BUILDS.windows && wsl ? toWindowsPath(modelsDir) : modelsDir;

step(`Serving the fleet on http://127.0.0.1:${port}`);
say(`  models  ${modelsArgument}`);
say("  Stop it with Ctrl+C. The workbench reaches it at the url in profile/web/cordis.patch.yml.\n");

const serverArgs = [
	"--models-dir",
	modelsArgument,
	// Two at once: the fleet's largest pair fits, so the router can change
	// member between turns without paying a model load (registry/models.yaml).
	"--models-max",
	"2",
	"--port",
	port,
	"-c",
	"16384",
	// Tool calling goes through the model's own chat template.
	"--jinja",
	"--no-webui",
	...(gpu ? ["-ngl", "99"] : ["-t", String(Math.max(1, (await import("node:os")).cpus().length)), "-ub", "1024", "-b", "2048"]),
	...passthrough.filter((argument, index) => argument !== "--port" && passthrough[index - 1] !== "--port"),
];

const server = spawn(binary, serverArgs, { cwd: build.dir, stdio: "inherit" });
server.on("error", (error) => fail(`could not start ${binary} — ${error.message}`));
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill());
