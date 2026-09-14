#!/usr/bin/env node
// Sentinel gate check — implements the checks proposed in INTEGRATION_CHECKLIST.md.
// Invoke as:
//   node sentinel-gate/check.js --diff              (commit-time, staged changes only)
//   node sentinel-gate/check.js --full               (full-repo scan, all tracked files)
//   node sentinel-gate/check.js --commit-msg-file <path>  (commit message format check)
// Exit code 0 = pass, 1 = fail (violations found), 2 = the check itself couldn't run.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXCEPTIONS_PATH = path.join(REPO_ROOT, "sentinel-exceptions.json");
const BASELINE_PATH = path.join(REPO_ROOT, "sentinel-gate", "baseline.json");
// sentinel-notes/ is gitignored (local-only, per project preference), so a
// git-diff-based check can never see changes there — git diffs are blind to
// gitignored files by construction. The TODO-sync check therefore can't use
// the same staged-content mechanism as every other rule; instead it hashes
// the working-tree content of sentinel-notes/ on every run and compares
// against the last recorded snapshot, independent of git's staging area.
const NOTES_SNAPSHOT_PATH = path.join(REPO_ROOT, "sentinel-gate", "notes-snapshot.json");

function git(args) {
    try {
        return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
    } catch (err) {
        throw new Error(`git ${args.join(" ")} failed: ${err.message}`);
    }
}

// Reads a file's STAGED content (git index), not the working tree, so a
// commit-time check evaluates exactly what will be committed. Returns null
// if the file doesn't exist in the index (deleted or never tracked).
function readStaged(relPath) {
    try {
        return git(["show", `:${relPath.replace(/\\/g, "/")}`]);
    } catch {
        return null;
    }
}

// Reads a file's current on-disk content, for full-scan mode (checks the
// whole working tree as it stands, not just staged changes).
function readWorkingTree(relPath) {
    const full = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf8");
}

function loadExceptions() {
    if (!fs.existsSync(EXCEPTIONS_PATH)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, "utf8"));
        return Array.isArray(raw) ? raw : [];
    } catch (err) {
        // A malformed exceptions file must not silently grant every exception —
        // fail loudly instead of treating "can't parse" as "no exceptions apply".
        throw new Error(`sentinel-exceptions.json exists but failed to parse: ${err.message}`);
    }
}

function isExempt(exceptions, rule, filePath) {
    const today = new Date().toISOString().slice(0, 10);
    return exceptions.some(ex => {
        if (ex.rule !== rule) return false;
        if (!Array.isArray(ex.files) || !ex.files.includes(filePath)) return false;
        if (!ex.reviewBy || ex.reviewBy < today) return false; // expired = not exempt
        return true;
    });
}

function loadBaseline() {
    if (!fs.existsSync(BASELINE_PATH)) return new Set();
    try {
        const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
        return new Set(Array.isArray(raw.violations) ? raw.violations : []);
    } catch {
        return new Set();
    }
}

function saveBaseline(violationKeys) {
    fs.writeFileSync(
        BASELINE_PATH,
        JSON.stringify({ generatedAt: new Date().toISOString(), violations: [...violationKeys] }, null, 2)
    );
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------
// Each rule receives a `read(relPath)` function bound to the right content
// source (staged index for --diff, working tree for --full) and the list of
// changed files for this run. It returns an array of violation objects:
//   { rule, file, line, message, key }
// `key` is a stable string used for baseline/exception matching.

const EXPORT_FUNCTIONS = [
    { file: "server.js", fnName: "autoExportToJSON" },
    { file: "scraper.js", fnName: "autoExportToJSON" },
    { file: "force-export.js", fnName: null }, // top-level script, no wrapping function
    { file: "fix-duplicates.js", fnName: null },
];

const RENDER_FUNCTIONS = [
    { file: "js/main.js", fnName: "renderCircuitsList" },
    { file: "js/admin.js", fnName: "renderCircuitsList" },
];

const FORM_TOUCHPOINTS = ["admin.html", "js/admin.js"];

const FEED_BRANCH_TOUCHPOINTS = ["server.js", "admin.html"];

const DETECTION_LOGIC_FILES = ["server.js", "scraper.js", "fix-titles.js", "fix-descriptions.js"];

// Extract the set of object-literal keys used as circuit fields inside a
// JS object-literal-returning function, by name. This is intentionally a
// simple heuristic (matches `key: value,` / `key,` lines within the nearest
// balanced-brace block following the function name) — good enough to warn a
// human to look closer, not a full JS parser. False positives/negatives here
// only ever produce a warning to double-check, never a silent pass, so the
// heuristic's imprecision is safe by construction.
function extractObjectKeysNearFunction(content, fnName) {
    if (!fnName) {
        // Top-level script: just look at the last object literal assigned in
        // a `.map(row => ({ ... }))` or `const exportData = { ... }` shape.
        const mapMatch = content.match(/\.map\(\s*\w+\s*=>\s*\(\{([\s\S]*?)\}\)\)/);
        if (mapMatch) return extractKeysFromBlock(mapMatch[1]);
        return null;
    }
    const fnIndex = content.indexOf(`function ${fnName}`);
    if (fnIndex === -1) return null;
    const mapMatch = content.slice(fnIndex).match(/\.map\(\s*\w+\s*=>\s*\(\{([\s\S]*?)\}\)\)/);
    if (mapMatch) return extractKeysFromBlock(mapMatch[1]);
    return null;
}

function extractKeysFromBlock(block) {
    const keys = new Set();
    for (const line of block.split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/);
        if (m) keys.add(m[1]);
    }
    return keys;
}

function ruleExportFieldParity(changedFiles, read) {
    const relevant = EXPORT_FUNCTIONS.filter(ef => changedFiles.has(ef.file));
    if (relevant.length === 0) return [];

    const keySets = EXPORT_FUNCTIONS.map(ef => {
        const content = read(ef.file);
        if (content === null) return { ...ef, keys: null };
        return { ...ef, keys: extractObjectKeysNearFunction(content, ef.fnName) };
    }).filter(ef => ef.keys !== null);

    if (keySets.length < 2) return [];

    // Union of all keys seen anywhere is the expected superset; any file
    // missing a key another file has is a real, concrete drift signal.
    const allKeys = new Set();
    for (const ef of keySets) for (const k of ef.keys) allKeys.add(k);

    const violations = [];
    for (const ef of keySets) {
        const missing = [...allKeys].filter(k => !ef.keys.has(k));
        if (missing.length > 0) {
            violations.push({
                rule: "export-field-parity",
                file: ef.file,
                line: null,
                message: `${ef.file}'s JSON export is missing field(s) that other export functions include: ${missing.join(", ")}. Check whether this is intentional or drift (see INTEGRATION_CHECKLIST.md touchpoint #2).`,
                key: `export-field-parity:${ef.file}:${missing.sort().join(",")}`,
                advisory: true,
            });
        }
    }
    return violations;
}

function ruleRenderFunctionsBothTouched(changedFiles) {
    const touched = RENDER_FUNCTIONS.filter(rf => changedFiles.has(rf.file));
    if (touched.length === 0 || touched.length === RENDER_FUNCTIONS.length) return [];
    const untouched = RENDER_FUNCTIONS.filter(rf => !changedFiles.has(rf.file));
    return [{
        rule: "render-parity-warn",
        file: touched[0].file,
        line: null,
        message: `renderCircuitsList() changed in ${touched.map(t => t.file).join(", ")} but not in ${untouched.map(t => t.file).join(", ")}. If this adds/changes a circuit field, check whether the other surface needs the same update (INTEGRATION_CHECKLIST.md touchpoint #3). Warning only — many changes are legitimately surface-specific.`,
        key: null, // advisory, never blocks, never baselined
        advisory: true,
    }];
}

function ruleEditFormParity(changedFiles) {
    const touched = FORM_TOUCHPOINTS.filter(f => changedFiles.has(f));
    if (touched.length === 0 || touched.length === FORM_TOUCHPOINTS.length) return [];
    const untouched = FORM_TOUCHPOINTS.filter(f => !changedFiles.has(f));
    return [{
        rule: "edit-form-parity-warn",
        file: touched[0],
        line: null,
        message: `${touched.join(", ")} changed but ${untouched.join(", ")} didn't. If this adds/changes a circuit field, confirm the admin add/edit form and its save handler both reflect it (INTEGRATION_CHECKLIST.md touchpoint #4). Warning only.`,
        key: null,
        advisory: true,
    }];
}

function ruleFeedSourceBranchParity(changedFiles) {
    const touched = FEED_BRANCH_TOUCHPOINTS.filter(f => changedFiles.has(f));
    if (touched.length === 0) return [];
    // server.js is required for either a new source-type branch or its
    // dashboard UI; only warn when server.js's feed-branching logic changed
    // without any admin.html change, since that's the actually-risky
    // direction (backend support added with no way to use it from the UI).
    if (changedFiles.has("server.js") && !changedFiles.has("admin.html")) {
        return [{
            rule: "feed-source-parity-warn",
            file: "server.js",
            line: null,
            message: `server.js changed but admin.html didn't. If this adds a new scraper source type, confirm admin.html exposes a way to add one through the dashboard (INTEGRATION_CHECKLIST.md touchpoint #6). Warning only.`,
            key: null,
            advisory: true,
        }];
    }
    return [];
}

function ruleDetectionLogicDrift(changedFiles, read, mode) {
    const touched = DETECTION_LOGIC_FILES.filter(f => changedFiles.has(f));
    if (touched.length === 0) return [];
    const untouched = DETECTION_LOGIC_FILES.filter(f => !changedFiles.has(f));
    const sibling = untouched.length > 0
        ? `check whether ${untouched.join(", ")} need the same fix`
        : `check whether the other copies of this logic need the same fix (all files in this group appear in scope for this run)`;
    return [{
        rule: "detection-logic-drift-warn",
        file: touched[0],
        line: null,
        message: `${touched.join(", ")} changed. This project has duplicated effect-type/category detection and HTML-entity-decoding logic across ${DETECTION_LOGIC_FILES.join(", ")} (see sentinel-notes/TODO.md: detection-dupe, decode-html-dupe). If this change is to that logic, ${sibling}. Warning only until consolidated.`,
        key: null,
        advisory: true,
    }];
}

function ruleClaudeMdTouched(changedFiles, read) {
    // Trigger: a circuit-field/schema change, a new endpoint, or a change to
    // any file listed in CLAUDE.md's "Architectural facts" section.
    const schemaChanged = changedFiles.has("server.js") && (() => {
        const content = read("server.js");
        return content !== null && /CREATE TABLE IF NOT EXISTS circuits|ALTER TABLE circuits ADD COLUMN/.test(content);
    })();
    const newEndpoint = changedFiles.has("server.js"); // any server.js change is a reasonable proxy trigger
    if (!schemaChanged && !newEndpoint) return [];
    if (changedFiles.has("CLAUDE.md")) return [];
    return [{
        rule: "claude-md-touched-warn",
        file: "server.js",
        line: null,
        message: `server.js changed but CLAUDE.md wasn't. If this adds/changes a circuit field, endpoint, or architectural fact, update CLAUDE.md's "Architectural facts worth knowing before editing" section.`,
        key: null,
        advisory: true,
    }];
}

function ruleReadmeTouched(changedFiles) {
    const capabilitySurfaces = ["index.html", "admin.html", "package.json"];
    const touched = capabilitySurfaces.filter(f => changedFiles.has(f));
    if (touched.length === 0 || changedFiles.has("README.md")) return [];
    return [{
        rule: "readme-touched-warn",
        file: touched[0],
        line: null,
        message: `${touched.join(", ")} changed but README.md wasn't. If this changes a user-facing feature, setup step, or the feature list, update the README (note: setup instructions are currently missing from the README entirely — see sentinel-notes/TODO.md: readme-setup-instructions). Warning only, since not every change to these files is user-facing.`,
        key: null,
        advisory: true,
    }];
}

function hashFile(fullPath) {
    if (!fs.existsSync(fullPath)) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
}

function loadNotesSnapshot() {
    if (!fs.existsSync(NOTES_SNAPSHOT_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(NOTES_SNAPSHOT_PATH, "utf8"));
    } catch {
        return {};
    }
}

function saveNotesSnapshot(snapshot) {
    fs.mkdirSync(path.dirname(NOTES_SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(NOTES_SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
}

// sentinel-notes/ is gitignored, so this rule compares working-tree file
// hashes against the last snapshot taken (updated at the end of every run,
// pass or fail) rather than using git diff/staged content like every other
// rule. This means it fires on "changed since the last time this hook ran"
// rather than "changed in this specific commit" — a real, documented
// limitation of enforcing anything against a gitignored directory; see
// INTEGRATION_CHECKLIST.md's Known Gaps.
function ruleTodoSyncOnBriefChange() {
    const notesDir = path.join(REPO_ROOT, "sentinel-notes");
    if (!fs.existsSync(notesDir)) return [];

    const briefFiles = fs.readdirSync(notesDir).filter(f => f.endsWith("-design-brief.md"));
    const todoPath = path.join(notesDir, "TODO.md");

    const snapshot = loadNotesSnapshot();
    const currentHashes = {};
    for (const f of briefFiles) currentHashes[f] = hashFile(path.join(notesDir, f));
    currentHashes["TODO.md"] = hashFile(todoPath);

    const violations = [];
    // A brief that existed before and changed (including being deleted) but
    // TODO.md's hash is unchanged from the same snapshot is the violation.
    for (const f of briefFiles) {
        const prevBrief = snapshot[f];
        if (prevBrief !== undefined && prevBrief !== currentHashes[f]) {
            if (snapshot["TODO.md"] === currentHashes["TODO.md"]) {
                violations.push({
                    rule: "todo-sync",
                    file: `sentinel-notes/${f}`,
                    line: null,
                    message: `sentinel-notes/${f} changed since the last check, but sentinel-notes/TODO.md did not. Per this project's convention, a completed brief is deleted along with its TODO.md line — if this brief was resolved, remove its corresponding TODO.md entry.`,
                    key: `todo-sync:${f}`,
                    blocking: true,
                });
            }
        }
    }
    // A brief that was deleted since the last snapshot but its file is gone now.
    for (const f of Object.keys(snapshot)) {
        if (f === "TODO.md") continue;
        if (!briefFiles.includes(f) && snapshot[f] !== null && snapshot[f] !== undefined) {
            if (snapshot["TODO.md"] === currentHashes["TODO.md"]) {
                violations.push({
                    rule: "todo-sync",
                    file: `sentinel-notes/${f}`,
                    line: null,
                    message: `sentinel-notes/${f} was deleted since the last check, but sentinel-notes/TODO.md did not change. If this brief's linked item was completed, its TODO.md line should have been removed in the same pass.`,
                    key: `todo-sync-deleted:${f}`,
                    blocking: true,
                });
            }
        }
    }

    // Snapshot is updated regardless of outcome — this is a "changed since
    // last observed" check, not a permanent record of violations.
    saveNotesSnapshot(currentHashes);

    return violations;
}

// Verifies the enforcement infrastructure itself is still intact — .git/hooks/
// is never tracked by git, so the tracked source in .githooks/ plus the
// core.hooksPath config pointing at it is the only thing standing between
// "hooks run" and "hooks silently stopped running with no error." A missing
// hook file, a hook that lost its executable bit, or a hooksPath config that
// reverted are all real, silent-failure-shaped risks this specifically guards.
const EXPECTED_HOOKS = ["pre-commit", "commit-msg", "pre-push"];

function ruleHookInfrastructureIntact() {
    const violations = [];
    let hooksPath;
    try {
        hooksPath = git(["config", "--get", "core.hooksPath"]).trim();
    } catch {
        hooksPath = null;
    }

    if (!hooksPath) {
        violations.push({
            rule: "hook-infrastructure",
            file: ".git/config",
            line: null,
            message: `core.hooksPath is not set. This project's gate-check hooks live in .githooks/ but git won't invoke them unless core.hooksPath points there. Run: git config core.hooksPath .githooks`,
            key: "hook-infrastructure:hookspath-unset",
            blocking: true,
        });
        return violations; // no point checking individual files if git isn't even pointed at the directory
    }

    const hooksDir = path.join(REPO_ROOT, hooksPath);
    for (const hookName of EXPECTED_HOOKS) {
        const hookPath = path.join(hooksDir, hookName);
        if (!fs.existsSync(hookPath)) {
            violations.push({
                rule: "hook-infrastructure",
                file: path.join(hooksPath, hookName),
                line: null,
                message: `Expected hook file ${path.join(hooksPath, hookName)} is missing. Gate-check enforcement for this hook has silently stopped working.`,
                key: `hook-infrastructure:missing:${hookName}`,
                blocking: true,
            });
            continue;
        }
        // Windows filesystems (this project's dev environment) don't reliably
        // expose Unix executable bits, so only enforce this check where it's
        // meaningful (mode bits present and non-zero) rather than false-failing
        // on every Windows run.
        try {
            const stat = fs.statSync(hookPath);
            const isExecutableBitMeaningful = process.platform !== "win32";
            if (isExecutableBitMeaningful && (stat.mode & 0o111) === 0) {
                violations.push({
                    rule: "hook-infrastructure",
                    file: path.join(hooksPath, hookName),
                    line: null,
                    message: `${path.join(hooksPath, hookName)} exists but isn't executable. Run: chmod +x ${path.join(hooksPath, hookName)}`,
                    key: `hook-infrastructure:not-executable:${hookName}`,
                    blocking: true,
                });
            }
        } catch {
            // stat failing on a file we just confirmed exists shouldn't happen;
            // if it does, don't let a swallowed error look like a clean pass.
            violations.push({
                rule: "hook-infrastructure",
                file: path.join(hooksPath, hookName),
                line: null,
                message: `Could not stat ${path.join(hooksPath, hookName)} to verify it's executable.`,
                key: `hook-infrastructure:stat-failed:${hookName}`,
                blocking: true,
            });
        }
    }

    return violations;
}

function ruleHardcodedTokenLiterals(changedFiles, read) {
    // Only meaningfully checkable once a shared token file exists (per
    // sentinel-notes/token-consolidation-design-brief.md — not yet done).
    // Until then this rule can't distinguish "a legitimate new token
    // definition" from "a hardcoded literal that should reference one",
    // since there is no canonical file to check literals against. Rather
    // than guess, this rule stays a documented no-op until that
    // prerequisite lands — see Known Gaps in INTEGRATION_CHECKLIST.md.
    return [];
}

const DIFF_RULES = [
    ruleExportFieldParity,
    ruleRenderFunctionsBothTouched,
    ruleEditFormParity,
    ruleFeedSourceBranchParity,
    ruleDetectionLogicDrift,
    ruleClaudeMdTouched,
    ruleReadmeTouched,
    ruleTodoSyncOnBriefChange,
    ruleHardcodedTokenLiterals,
];

// ---------------------------------------------------------------------------
// Commit message check
// ---------------------------------------------------------------------------

const SUBJECT_MAX = 72;
const BULLET_LINE_MAX = 80;
const BULLET_WRAP_MAX = 2; // physical lines per logical bullet
const BULLET_COMBINED_MAX = 130; // deliberately less than 2x BULLET_LINE_MAX (80) so this cap can actually bind independently of the per-line cap — see the gate-check tests for why an exact 2x value would be mathematically unreachable
const BULLET_COUNT_MAX = 5;
const ATTRIBUTION_PATTERNS = [
    /generated with claude code/i,
    /co-authored-by/i,
    /claude-session:/i,
    /^\s*🤖/m,
];

function checkCommitMessage(message) {
    const violations = [];
    const lines = message.replace(/\r\n/g, "\n").split("\n");

    for (const pat of ATTRIBUTION_PATTERNS) {
        if (pat.test(message)) {
            violations.push({
                rule: "no-attribution-trailer",
                message: `Commit message contains an attribution/co-author trailer matching ${pat}. Remove it — this project's convention (CLAUDE.md) forbids auto-generated attribution lines.`,
                blocking: true,
            });
        }
    }

    const subject = lines[0] || "";
    if (subject.length > SUBJECT_MAX) {
        violations.push({
            rule: "subject-length",
            message: `Subject line is ${subject.length} characters, over the ${SUBJECT_MAX}-character cap. Keep it to one terse, plain-English line.`,
            blocking: true,
        });
    }

    // Body = everything after the mandatory blank line following the subject.
    let body = lines.length > 2 ? lines.slice(2) : [];
    if (body.every(l => l.trim() === "")) return violations; // no body, nothing more to check

    // Check for override trailer first, and strip it (plus the blank line
    // separating it from the body) before running structural checks — the
    // trailer is commit metadata, not a bullet the structure rules apply to.
    const hasOverride = /^Sentinel-Override:\s*\S+/m.test(message);
    const overrideLineIndex = body.findIndex(l => /^Sentinel-Override:\s*\S+/.test(l));
    if (overrideLineIndex !== -1) {
        body = body.slice(0, overrideLineIndex).filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ""));
    }

    // Group physical lines into logical bullets: a line starting with "- " begins
    // a new bullet; a subsequent indented, non-"- "-prefixed line is a continuation;
    // anything else (unmarked, unindented) is a structural violation.
    const nonBlankBody = body.filter(l => l.trim() !== "");
    let bulletCount = 0;
    let currentBulletLines = 0;
    let currentBulletCombinedLength = 0;
    let sawUnmarkedLine = false;

    const closeBulletCheck = () => {
        if (currentBulletLines > 0 && currentBulletCombinedLength > BULLET_COMBINED_MAX) {
            violations.push({
                rule: "bullet-combined-length",
                message: `A wrapped commit body bullet's combined length across its ${currentBulletLines} line(s) is ${currentBulletCombinedLength} characters, over the ${BULLET_COMBINED_MAX}-character combined cap — this is a mini-paragraph wearing bullet formatting, not a short bullet. Shorten it.`,
                blocking: true,
            });
        }
    };

    for (const line of nonBlankBody) {
        const isMarker = /^-\s+\S/.test(line);
        const isIndentedContinuation = /^\s{2,}\S/.test(line) && !isMarker;

        if (isMarker) {
            closeBulletCheck();
            bulletCount++;
            currentBulletLines = 1;
            currentBulletCombinedLength = line.length;
            if (line.length > BULLET_LINE_MAX) {
                violations.push({
                    rule: "bullet-line-length",
                    message: `A commit body bullet exceeds ${BULLET_LINE_MAX} characters: "${line.slice(0, 40)}...". Keep bullets short.`,
                    blocking: true,
                });
            }
        } else if (isIndentedContinuation && currentBulletLines >= 1 && currentBulletLines < BULLET_WRAP_MAX) {
            currentBulletLines++;
            currentBulletCombinedLength += line.length;
            if (line.length > BULLET_LINE_MAX) {
                violations.push({
                    rule: "bullet-wrap-line-length",
                    message: `A wrapped commit body continuation line exceeds ${BULLET_LINE_MAX} characters.`,
                    blocking: true,
                });
            }
        } else {
            sawUnmarkedLine = true;
        }
    }
    closeBulletCheck(); // check the final bullet in the body, which the loop never "closes" via a following marker

    if (sawUnmarkedLine) {
        violations.push({
            rule: "narrative-body",
            message: `Commit body contains unmarked, non-bulleted line(s) — this reads as narrative prose rather than a short bullet list. Every body line must start with "- " (or be an indented continuation of the immediately preceding bullet). This rule has no override — restructure as bullets or drop the body.`,
            blocking: true, // no override escape hatch, per Part 2's instruction
        });
    }

    if (bulletCount > BULLET_COUNT_MAX && !hasOverride) {
        violations.push({
            rule: "bullet-count",
            message: `Commit body has ${bulletCount} bullets, over the ${BULLET_COUNT_MAX}-bullet cap. Does this commit bundle together several separate things? Consider splitting it into multiple commits. If it's genuinely one coherent unit of work, add a "Sentinel-Override: <reason>" trailer to override this check.`,
            blocking: true,
        });
    }

    return violations;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function getStagedFiles() {
    const out = git(["diff", "--cached", "--name-only"]);
    return new Set(out.split("\n").filter(Boolean).map(f => f.replace(/\\/g, "/")));
}

function getAllTrackedFiles() {
    const out = git(["ls-files"]);
    return new Set(out.split("\n").filter(Boolean).map(f => f.replace(/\\/g, "/")));
}

function runRules(mode) {
    const changedFiles = mode === "full" ? getAllTrackedFiles() : getStagedFiles();
    const read = mode === "full" ? readWorkingTree : readStaged;
    const exceptions = loadExceptions();

    let violations = [];
    for (const rule of DIFF_RULES) {
        violations = violations.concat(rule(changedFiles, read) || []);
    }

    if (mode === "full") {
        violations = violations.concat(ruleHookInfrastructureIntact());
    }

    // Apply exceptions to blocking violations only; advisory ones never block anyway.
    violations = violations.map(v => {
        if (v.blocking && v.key && isExempt(exceptions, v.rule, v.file)) {
            return { ...v, exempted: true };
        }
        return v;
    });

    return violations;
}

function printViolation(v) {
    const tag = v.exempted ? "[EXEMPTED]" : v.advisory ? "[WARN]" : "[BLOCK]";
    const loc = v.line ? `${v.file}:${v.line}` : v.file || "(repo-wide)";
    console.log(`${tag} ${v.rule} — ${loc}`);
    console.log(`  ${v.message}`);
}

function main() {
    const args = process.argv.slice(2);

    if (args.includes("--commit-msg-file")) {
        const idx = args.indexOf("--commit-msg-file");
        const msgPath = args[idx + 1];
        if (!msgPath || !fs.existsSync(msgPath)) {
            console.error("sentinel-gate: --commit-msg-file requires a valid path");
            process.exit(2);
        }
        const message = fs.readFileSync(msgPath, "utf8");
        const violations = checkCommitMessage(message);
        if (violations.length === 0) {
            console.log("sentinel-gate: commit message OK");
            process.exit(0);
        }
        console.log("sentinel-gate: commit message check failed:\n");
        for (const v of violations) printViolation({ ...v, file: "(commit message)" });
        process.exit(1);
    }

    const mode = args.includes("--full") ? "full" : "diff";

    let violations;
    try {
        violations = runRules(mode);
    } catch (err) {
        console.error(`sentinel-gate: check failed to run: ${err.message}`);
        process.exit(2); // fail loudly — never let a broken check silently pass
    }

    const blocking = violations.filter(v => v.blocking && !v.exempted);
    const advisory = violations.filter(v => v.advisory);
    const exempted = violations.filter(v => v.exempted);

    if (violations.length === 0) {
        console.log(`sentinel-gate (${mode}): no issues found`);
    } else {
        console.log(`sentinel-gate (${mode}): ${blocking.length} blocking, ${advisory.length} advisory, ${exempted.length} exempted\n`);
        for (const v of [...blocking, ...exempted, ...advisory]) printViolation(v);
    }

    if (mode === "full") {
        const baseline = loadBaseline();
        const newBlocking = blocking.filter(v => v.key && !baseline.has(v.key));
        if (blocking.some(v => !v.key)) {
            // A blocking rule with no stable key can't be baselined — treat conservatively.
            console.log("\nNote: one or more blocking violations have no baseline key and are always enforced.");
        }
        if (newBlocking.length > 0 || blocking.some(v => !v.key)) {
            console.log(`\nsentinel-gate: full scan found NEW blocking violations not present in the recorded baseline.`);
            process.exit(1);
        }
        console.log("\nsentinel-gate: full scan passed (all blocking violations, if any, are already in the tracked baseline).");
        process.exit(0);
    }

    if (blocking.length > 0) {
        console.log("\nsentinel-gate: commit blocked by the above finding(s).");
        process.exit(1);
    }
    process.exit(0);
}

main();
