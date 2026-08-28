/**
 * Tests for the report-findings tool (Story 5.1): the real tool call an agent
 * run makes to read the ingested inspection report's OCR findings before
 * turning them into key findings with provenance.
 *
 *     node --test plugins/dsh-client-ui-base/test/*.test.js
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReportFindingsTool, REPORT_FINDINGS_TOOL_NAME } from "../lib/findings/tool.js";

test("the definition carries everything ToolRuntime.register demands", () => {
	const tool = createReportFindingsTool();
	assert.equal(tool.name, REPORT_FINDINGS_TOOL_NAME);
	assert.equal(typeof tool.description, "string");
	assert.equal(tool.parameters.type, "object");
	assert.equal(typeof tool.output, "object");
	assert.equal(tool.output.schema.type, "object");
	assert.equal(typeof tool.output.render, "function");
	assert.equal(typeof tool.execute, "function");
});

test("execute reads the shipped fixture — a real file read, not fabricated data", async () => {
	const tool = createReportFindingsTool();
	const value = await tool.execute();
	assert.equal(value.report, "sample-inspection-report.pdf");
	assert.ok(Array.isArray(value.findings));
	assert.ok(value.findings.length > 100, "the shipped capture has 156 real OCR lines");
	for (const finding of value.findings) {
		assert.equal(typeof finding.text, "string");
		assert.equal(typeof finding.confidence, "number");
		assert.ok(finding.page === 1 || finding.page === 2);
		assert.equal(typeof finding.bbox.left, "number");
		assert.equal(typeof finding.bbox.top, "number");
		assert.equal(typeof finding.bbox.width, "number");
		assert.equal(typeof finding.bbox.height, "number");
	}
});

test("carries the two Major findings the replay script cites, with their real provenance", async () => {
	const tool = createReportFindingsTool();
	const { findings } = await tool.execute();
	const e1104a = findings.find((f) => f.text.startsWith("Insulation cladding open"));
	assert.ok(e1104a, "the E-1104A corrosion finding is missing from the capture");
	assert.equal(e1104a.page, 1);
	assert.deepEqual(e1104a.bbox, { left: 560, top: 2048, width: 814, height: 58 });

	const psv = findings.find((f) => f.text.startsWith("Test tag expired"));
	assert.ok(psv, "the PSV-2207A test-tag finding is missing from the capture");
	assert.equal(psv.page, 1);
	assert.deepEqual(psv.bbox, { left: 560, top: 2171, width: 876, height: 60 });
});

test("reads fresh from disk on every call — no stale in-memory cache", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bf-findings-fixture-"));
	const fixturePath = join(dir, "findings.json");
	try {
		writeFileSync(fixturePath, JSON.stringify([{ text: "first", bbox: { left: 0, top: 0, width: 1, height: 1 }, confidence: 100, page: 1 }]));
		const tool = createReportFindingsTool(fixturePath);
		const first = await tool.execute();
		assert.equal(first.findings.length, 1);

		writeFileSync(fixturePath, JSON.stringify([]));
		const second = await tool.execute();
		assert.equal(second.findings.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("render gives the model the findings themselves, not just how many there were", () => {
	// This content is what the harness hands the model as the tool result, so a
	// summary alone left a real model with nothing to reason from — verified
	// against Qwen3.5-4B on 29 Aug 2026, which reported the findings missing.
	const tool = createReportFindingsTool();
	const findings = [
		{ text: "Insulation cladding open at the channel end", bbox: { left: 560, top: 2048, width: 814, height: 58 }, confidence: 100, page: 1 },
		{ text: "Test tag expired 04-2026", bbox: { left: 560, top: 2171, width: 876, height: 60 }, confidence: 98.6, page: 2 },
	];
	const content = tool.output.render({}, { report: "sample-inspection-report.pdf", findings });
	assert.equal(content[0].type, "text");
	assert.match(content[0].text, /2 OCR findings/);
	assert.match(content[0].text, /sample-inspection-report\.pdf/);
	// The text of each finding, and the provenance the product's claim rests on.
	assert.match(content[0].text, /Insulation cladding open at the channel end/);
	assert.match(content[0].text, /Test tag expired 04-2026/);
	assert.match(content[0].text, /p1 \| 560,2048,814,58/);
	assert.match(content[0].text, /p2 \| 560,2171,876,60/);
});
